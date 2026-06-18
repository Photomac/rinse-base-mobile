import * as Sentry from '@sentry/react-native'

// Dedicated "rinsebase-mobile" Sentry project (org rinsebase-app). Previously this
// reused the WEB app's DSN, which commingled mobile + web issues in one project;
// mobile now reports to its own project so crashes are cleanly separated (and show
// up tagged as mobile on the admin System Health "Live Errors" card). DSN is public
// (it ships in the client). (Source-map upload during builds still needs
// SENTRY_AUTH_TOKEN + org/project on the app.json plugin; add when ready —
// intentionally disabled for now per SENTRY_DISABLE_AUTO_UPLOAD in eas.json.)
Sentry.init({
  dsn: 'https://f58499b805c5368ac611bb0e837a6008@o4511111110459392.ingest.us.sentry.io/4511586838511616',
  environment: 'production',
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
})

export { Sentry }
export default Sentry
