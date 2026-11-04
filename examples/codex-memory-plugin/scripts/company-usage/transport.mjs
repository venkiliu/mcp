// RFC 7516 compact JWE for the team's legacy HTTP ingress.
import { constants, createCipheriv, createHmac, publicEncrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const b64 = value => Buffer.from(value).toString('base64url')
const header = b64(JSON.stringify({alg:'RSA-OAEP-256', enc:'A256GCM'}))
const publicOrigin = 'http://km.venkiliu.top:18443'

export async function postUsage(baseUrl, apiKey, rows) {
  const url = new URL(baseUrl)
  if (url.username || url.password || url.search || url.hash) throw Error('Invalid server URL')
  const headers = {'Content-Type':'application/json'}
  let key, encrypted, body, endpoint
  if (url.origin === publicOrigin && url.pathname === '/') {
    key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(header))
    const payload = JSON.stringify({api_key:apiKey, issued:Math.floor(Date.now()/1000), rows})
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
    const wrapped = publicEncrypt({key:readFileSync(new URL('./receiver-public.pem',import.meta.url)), oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING}, key)
    encrypted = [header,b64(wrapped),b64(iv),b64(ciphertext),b64(cipher.getAuthTag())].join('.')
    headers['Content-Type'] = 'application/jose'
    body = encrypted
    endpoint = new URL('/_codex_usage/report', url)
  } else {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname))) throw Error('Unsupported insecure server URL')
    headers.Authorization = 'Bearer ' + apiKey
    body = JSON.stringify({rows})
    endpoint = new URL('/api/v1/codex-usage/report',url)
  }
  const response = await fetch(endpoint, {method:'POST', headers, body, redirect:'error', signal:AbortSignal.timeout(30000)})
  if (!response.ok) throw Error('用量上报失败 HTTP '+response.status)
  const receipt = await response.json()
  if (encrypted) {
    const expected = createHmac('sha256',key).update('accepted\n'+encrypted).digest()
    const actual = Buffer.from(receipt.ack || '', 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(expected,actual)) throw Error('Invalid server receipt')
  }
  return receipt
}
