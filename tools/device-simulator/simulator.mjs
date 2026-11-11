// Site controller simulator. Publishes ATG tank readings and pump totalizers over MQTT.
// While the link is down it buffers readings with their ORIGINAL device timestamps and replays them
// on reconnect; the API de-duplicates by (site, device, timestamp), so replays are safe.
//
//   node simulator.mjs                 run continuously (Ctrl+C to stop)
//   node simulator.mjs --selftest      publish, drop the link, buffer, reconnect, replay, then exit
//
// Env: MQTT_URL (default mqtt://127.0.0.1:1883), SITE (default SITE-CPT-002), PRODUCT (default DIESEL_50)
import mqtt from 'mqtt'

const URL = process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883'
const SITE = process.env.SITE ?? 'SITE-CPT-002'
const PRODUCT = process.env.PRODUCT ?? 'DIESEL_50'
const selftest = process.argv.includes('--selftest')

let volume = 41000
let totalizer = 50000
const buffer = []
let client = null
let online = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function reading() {
  volume -= Math.round(Math.random() * 20)
  totalizer += 5
  const ts = new Date().toISOString()
  return [
    { topic: `maestro/${SITE}/tank/${PRODUCT}/reading`, body: { volumeL: volume, tempC: 21.5, waterMm: 1, ts } },
    { topic: `maestro/${SITE}/pump/P1/event`, body: { kind: 'TOTALIZER', value: totalizer, ts } },
  ]
}

function connect() {
  return new Promise((resolve, reject) => {
    client = mqtt.connect(URL, { clientId: `sim-${SITE}-${process.pid}`, reconnectPeriod: 0, connectTimeout: 4000 })
    client.once('connect', () => { online = true; resolve() })
    client.once('error', reject)
    client.on('close', () => { online = false })
  })
}

function publish(msg) {
  return new Promise((resolve) => {
    if (!online) { buffer.push(msg); return resolve(false) }
    client.publish(msg.topic, JSON.stringify(msg.body), { qos: 1 }, (err) => {
      if (err) buffer.push(msg)
      resolve(!err)
    })
  })
}

async function flush() {
  const pending = buffer.splice(0, buffer.length)
  for (const m of pending) await publish(m)
  return pending
}

async function tick() {
  for (const m of reading()) await publish(m)
}

if (selftest) {
  await connect()
  console.log(`connected to ${URL}`)
  await tick(); await tick()
  console.log('published 2 live readings (+2 pump events)')
  client.end(true)
  await sleep(300)
  online = false
  await tick(); await sleep(1100); await tick()
  console.log(`link down: buffered ${buffer.length} messages with original timestamps`)
  await connect()
  const replayed = await flush()
  console.log(`reconnected: replayed ${replayed.length} buffered messages`)
  // replay again on purpose: the server must ignore the duplicates
  for (const m of replayed) await publish(m)
  console.log('replayed the same messages a second time (server must ignore them)')
  await sleep(500)
  client.end()
  console.log(`done. final volume ${volume} L, totalizer ${totalizer}`)
} else {
  await connect()
  console.log(`simulating ${SITE}/${PRODUCT} on ${URL}`)
  client.on('close', () => console.log('link lost, buffering'))
  setInterval(async () => {
    if (!online) {
      try { await connect(); const n = (await flush()).length; console.log(`reconnected, replayed ${n}`) } catch { /* retry next tick */ }
    }
    await tick()
  }, 5000)
}
