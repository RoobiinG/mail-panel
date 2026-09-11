/**
 * Wie globales fetch, filtert aber Basic-Auth-Credentials aus der URL heraus
 * und wandelt sie in den Authorization-Header um, da Node.js fetch dies sonst ablehnt
 * ("Request cannot be constructed from a URL that includes credentials").
 */
async function fetchMitAuth(urlStr, optionen = {}) {
  let ziel = String(urlStr);
  const authMatch = ziel.match(/^(https?:\/\/)([^:@]+):([^@]+)@(.+)$/);
  
  if (authMatch) {
    const [, schema, user, pass, rest] = authMatch;
    // URL ohne Credentials zusammenbauen
    ziel = schema + rest;
    
    // Auth-Header hinzufügen
    optionen.headers = optionen.headers || {};
    
    let decodedUser = user;
    let decodedPass = pass;
    try { decodedUser = decodeURIComponent(user); } catch (e) {}
    try { decodedPass = decodeURIComponent(pass); } catch (e) {}
    
    const creds = decodedUser + ':' + decodedPass;
    optionen.headers['Authorization'] = 'Basic ' + Buffer.from(creds).toString('base64');
  }
  
  return fetch(ziel, optionen);
}

module.exports = fetchMitAuth;
