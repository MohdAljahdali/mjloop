/**
 * The one connection, and the demultiplexer for what arrives on it.
 *
 * Reconnection is silent and automatic rather than surfaced as an error: the
 * usual cause is the server restarting under a rebuild, and the page recovers
 * on its own. The banner says "retrying" because that is what is happening.
 */

/**
 * @typedef {import('../../protocol.js').ServerMessage} ServerMessage
 * @typedef {import('../../protocol.js').ClientMessage} ClientMessage
 *
 * @typedef {object} SocketPorts
 * @property {string} token
 * @property {(message: ServerMessage) => void} onMessage
 * @property {(online: boolean) => void} onStatus
 */

const RETRY_MS = 1000

/** @type {WebSocket | null} */
let socket = null
/** @type {SocketPorts | null} */
let ports = null

/**
 * @param {SocketPorts} injected
 */
export function connect(injected) {
  ports = injected
  open()
}

function open() {
  if (ports === null) return
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const next = new WebSocket(`${scheme}://${location.host}/?t=${encodeURIComponent(ports.token)}`)
  socket = next

  next.addEventListener('open', () => ports?.onStatus(true))

  next.addEventListener('message', (event) => {
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(String(event.data))
    } catch {
      // Nothing on this socket but our own server. A frame that is not JSON is
      // not a case to recover from, it is a case to ignore.
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    ports?.onMessage(/** @type {ServerMessage} */ (parsed))
  })

  next.addEventListener('close', () => {
    ports?.onStatus(false)
    setTimeout(open, RETRY_MS)
  })
}

/**
 * @param {ClientMessage} message
 */
export function send(message) {
  if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
