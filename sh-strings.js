'use strict';

/*
 * Sky Sling - localized strings for the StarHermit account controls
 * (sign-in, invite link, sign-out notice). Locale follows navigator.language
 * through the Graphics panel's picker.
 */
(function (root) {
  var EN = {
    signIn: 'Sign in with StarHermit',
    invite: 'Invite a friend',
    copied: 'Invite link copied',
    copyFailed: 'Could not copy the invite link',
    signedOut: 'Signed out of StarHermit — progress stays on this device',
    lbPosting: 'Posting score to the leaderboard…',
    lbRank: 'Leaderboard rank: #{rank}',
    lbPosted: 'Score posted to the leaderboard.',
    lbNotPosted: 'Score not posted to the leaderboard.'
  };
  var ES = {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    copied: 'Enlace de invitación copiado',
    copyFailed: 'No se pudo copiar el enlace de invitación',
    signedOut: 'Sesión de StarHermit cerrada: el progreso se queda en este dispositivo',
    lbPosting: 'Enviando la puntuación a la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación enviada a la clasificación.',
    lbNotPosted: 'La puntuación no se envió a la clasificación.'
  };
  var FR = {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    copied: 'Lien d’invitation copié',
    copyFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit — la progression reste sur cet appareil',
    lbPosting: 'Envoi du score au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Score envoyé au classement.',
    lbNotPosted: 'Score non envoyé au classement.'
  };
  var STRINGS = {
    'en-US': EN, 'en-GB': EN, 'es-419': ES, 'es-ES': ES,
    'de-DE': {
      signIn: 'Mit StarHermit anmelden',
      invite: 'Freund einladen',
      copied: 'Einladungslink kopiert',
      copyFailed: 'Einladungslink konnte nicht kopiert werden',
      signedOut: 'Von StarHermit abgemeldet – der Fortschritt bleibt auf diesem Gerät',
      lbPosting: 'Punktzahl wird an die Bestenliste gesendet…',
      lbRank: 'Platz in der Bestenliste: #{rank}',
      lbPosted: 'Punktzahl an die Bestenliste gesendet.',
      lbNotPosted: 'Punktzahl wurde nicht an die Bestenliste gesendet.'
    },
    'fr-FR': FR,
    'fr-CA': Object.assign({}, FR, { invite: 'Inviter un ami ou une amie', lbPosting: 'Envoi du pointage au classement…', lbPosted: 'Pointage envoyé au classement.', lbNotPosted: 'Pointage non envoyé au classement.' }),
    'pt-BR': {
      signIn: 'Entrar com StarHermit',
      invite: 'Convidar um amigo',
      copied: 'Link de convite copiado',
      copyFailed: 'Não foi possível copiar o link de convite',
      signedOut: 'Sessão do StarHermit encerrada — o progresso fica neste dispositivo',
      lbPosting: 'Enviando a pontuação para o ranking…',
      lbRank: 'Posição no ranking: #{rank}',
      lbPosted: 'Pontuação enviada ao ranking.',
      lbNotPosted: 'Pontuação não enviada ao ranking.'
    },
    'it-IT': {
      signIn: 'Accedi con StarHermit',
      invite: 'Invita un amico',
      copied: 'Link di invito copiato',
      copyFailed: 'Impossibile copiare il link di invito',
      signedOut: 'Disconnesso da StarHermit: i progressi restano su questo dispositivo',
      lbPosting: 'Invio del punteggio alla classifica…',
      lbRank: 'Posizione in classifica: #{rank}',
      lbPosted: 'Punteggio inviato alla classifica.',
      lbNotPosted: 'Punteggio non inviato alla classifica.'
    }
  };
  function strings(lang) {
    var ss = root.SkySling || {};
    var key = ss.gfxui ? ss.gfxui.pickLocale(lang) : 'en-US';
    return STRINGS[key] || EN;
  }
  var api = { STRINGS: STRINGS, strings: strings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.shStrings = api;
})(typeof self !== 'undefined' ? self : globalThis);
