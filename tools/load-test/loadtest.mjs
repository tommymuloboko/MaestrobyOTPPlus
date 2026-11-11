// Load test for the API. Start the API with the rate limiter off, otherwise you measure the limiter:
//   .\mvnw.cmd spring-boot:run "-Dspring-boot.run.arguments=--server.port=8087 --maestro.mqtt.enabled=false --maestro.rate-limit.per-minute=0 --maestro.rate-limit.login-per-minute=0"
//   node loadtest.mjs            (API=http://localhost:8087/api/v1 CONNECTIONS=50 DURATION=15)
import autocannon from 'autocannon'

const API = process.env.API ?? 'http://localhost:8087/api/v1'
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50)
const DURATION = Number(process.env.DURATION ?? 15)

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Maestro#2026' }),
  })
  if (!r.ok) throw new Error(`login ${email} failed: ${r.status}`)
  return (await r.json()).token
}

const adminToken = await login('admin@maestro.test')
const acmeToken = await login('fleet@acme.test')

function run(title, opts) {
  return new Promise((resolve, reject) => {
    autocannon({ connections: CONNECTIONS, duration: DURATION, title, ...opts }, (err, res) => {
      if (err) return reject(err)
      const non2xx = res.non2xx
      console.log(
        `${title.padEnd(34)} ${String(Math.round(res.requests.average)).padStart(6)} req/s  ` +
          `p50 ${res.latency.p50} ms  p97.5 ${res.latency.p97_5} ms  p99 ${res.latency.p99} ms  ` +
          `errors ${res.errors}  non-2xx ${non2xx}  (${res.requests.total} requests)`,
      )
      resolve(res)
    })
  })
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

console.log(`API ${API}, ${CONNECTIONS} connections, ${DURATION}s per scenario\n`)
await run('GET /orders (customer)', { url: `${API}/orders`, headers: auth(acmeToken) })
await run('GET /stock (admin)', { url: `${API}/stock`, headers: auth(adminToken) })
await run('GET /insights/dashboard (admin)', { url: `${API}/insights/dashboard`, headers: auth(adminToken) })
await run('POST /orders (customer, write)', {
  url: `${API}/orders`,
  method: 'POST',
  headers: auth(acmeToken),
  body: JSON.stringify({
    siteCode: 'SITE-JHB-001',
    fuelProduct: 'DIESEL_50',
    quantityLitres: 10,
    vehicleReg: 'CA 123-456',
    driverName: 'S. Dlamini',
  }),
})
await run('POST /auth/login', {
  url: `${API}/auth/login`,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'fleet@acme.test', password: 'Maestro#2026' }),
})
