import { describe, expect, it } from 'vitest'
import { isLocalPath, readRequest, requestFields } from '../src/shared/seal2/http'

describe('a path the seal carries (seal2/http.ts)', () => {
  it('is a path on this server and nothing a server would read as another', () => {
    for (const path of ['/', '/api/x', '/api/x?y=1&z=%2F', '/api/watch/item/n1/frame']) expect(isLocalPath(path), path).toBe(true)
    for (const path of ['', 'api/x', '//host/x', '/a\\b', '/a b', '/a\nb', 'https://x/y', '/api/x#y', '/api/watch/item/..#/frame', '/api/terminal/..#/input', '/api/x/.#x', '/#'])
      expect(isLocalPath(path), path).toBe(false)
  })

  it('neither builds nor reads a request whose path has a fragment', () => {
    expect(() => requestFields('GET', '/api/x#y')).toThrow()
    expect(readRequest({ ':method': 'GET', ':path': '/api/x#y' })).toBeNull()
    expect(readRequest({ ':method': 'GET', ':path': '/api/x?y=1' })).toEqual({ method: 'GET', path: '/api/x?y=1', headers: {} })
  })
})
