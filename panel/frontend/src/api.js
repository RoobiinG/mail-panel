import axios from 'axios';
import { token, abmelden } from './lib/session';

// Zentrale Axios-Instanz: haengt das JWT an und meldet bei 401 sauber ab.
//
// 401 = die Sitzung taugt nicht mehr (abgelaufen, ungueltig, Zugang geloescht).
// 403 = angemeldet, aber fuer diese Seite nicht berechtigt — da waere ein
// Abmelden falsch, das bleibt bewusst stehen.
const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const wert = token();
  if (wert) config.headers.Authorization = `Bearer ${wert}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Auf der Anmeldemaske selbst ist eine 401 ganz normal (falsches
      // Passwort) — dort darf nichts umgeleitet werden.
      if (window.location.pathname !== '/login') {
        abmelden(err.response.data?.error || 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.');
      }
    }
    return Promise.reject(err);
  },
);

export default api;
