import * as Sentry from '@sentry/react-native'

// NOTE: this reuses the WEB app's Sentry DSN, so mobile crashes land in the same
// Sentry project (tagged by platform, so still filterable). RECOMMENDED: create a
// dedicated "rinsebase-mobile" project in your Sentry org and swap this DSN — keeps
// web vs mobile issues cleanly separated. (Source-map upload during builds also
// needs SENTRY_AUTH_TOKEN + org/project on the app.json plugin; add when ready.)
Sentry.init({
  dsn: 'https://f82ac1e76f2f294f3649aa1a02169c1f@o4511111110459392.ingest.us.sentry.io/4511111117406208',
  environment: 'production',
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
})

export { Sentry }
export default Sentry
