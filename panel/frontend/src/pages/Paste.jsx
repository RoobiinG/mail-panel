import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, ShieldCheck, AlertCircle, Copy, Check } from 'lucide-react';
import api from '../api';

async function decryptGCM(encryptedBase64, hexKey) {
  try {
    const rawData = atob(encryptedBase64);
    const data = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) data[i] = rawData.charCodeAt(i);

    // IV (12 Bytes), Auth Tag (16 Bytes), Ciphertext
    const iv = data.slice(0, 12);
    const tag = data.slice(data.length - 16);
    const ciphertext = data.slice(12, data.length - 16);

    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      new Uint8Array(hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16))),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      cryptoKey,
      new Uint8Array([...ciphertext, ...tag]) // subtle expects ciphertext and tag concatenated
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    throw new Error('Entschlüsselung fehlgeschlagen. Ist der Schlüssel im Link korrekt?');
  }
}

export default function Paste() {
  const { id } = useParams();
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fetchAndDecrypt = async () => {
      try {
        const res = await api.get(`/api/paste/${id}`);
        const hash = window.location.hash.substring(5); // "#key=..."
        if (!hash) {
          throw new Error('Der Schlüssel fehlt im URL-Hash.');
        }

        const decryptedText = await decryptGCM(res.data.payload, hash);
        setContent(decryptedText);
      } catch (err) {
        setError(err.response?.data?.error || err.message || 'Ein Fehler ist aufgetreten');
      } finally {
        setLoading(false);
      }
    };

    fetchAndDecrypt();
  }, [id]);

  const copyText = () => {
    if (content) {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-panel-bg text-panel-text flex flex-col items-center p-4">
      <div className="w-full max-w-5xl mt-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ShieldCheck className="text-panel-accent" /> Verschlüsseltes Log
          </h1>
          {content && (
            <button
              onClick={copyText}
              className="btn btn-secondary flex items-center gap-2 text-xs"
            >
              {copied ? <Check size={14} className="text-panel-accent" /> : <Copy size={14} />}
              {copied ? 'Kopiert' : 'Kopieren'}
            </button>
          )}
        </div>

        {loading && (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-panel-accent" size={32} />
          </div>
        )}

        {error && (
          <div className="p-4 bg-panel-red/10 border border-panel-red/20 rounded-md text-panel-red flex items-center gap-3">
            <AlertCircle size={20} />
            {error}
          </div>
        )}

        {content && (
          <div className="bg-panel-surface border border-panel-border rounded-lg overflow-hidden shadow-lg">
            <div className="p-2 border-b border-panel-border/50 bg-panel-darker/50 flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-panel-red/50"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-panel-accent/50"></div>
              <span className="text-[10px] text-panel-muted ml-2 font-mono">End-to-End Encrypted</span>
            </div>
            <pre className="p-4 overflow-auto max-h-[70vh] text-xs font-mono text-panel-text/90 whitespace-pre-wrap break-words">
              {content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
