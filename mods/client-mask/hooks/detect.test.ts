import { test, expect } from 'claude-code/testing'

import { Detector } from './detect'

const d = new Detector()

test('personal data becomes a plain label that cannot be turned back', async () => {
  expect(d.mask('Mail jane.doe@northwind.test or call 07700 900123')).toBe('Mail ‹EMAIL› or call ‹PHONE›')
  expect(d.mask('NI number AB 12 34 56 C')).toBe('NI number ‹NI_NUMBER›')
  expect(d.mask('Pay GB82 WEST 1234 5698 7654 32 TODAY')).toBe('Pay ‹IBAN› TODAY')
  expect(d.mask('Card 4111 1111 1111 1111')).toBe('Card ‹CARD›')
  expect(d.mask('VAT GB 123 4567 89')).toBe('VAT ‹VAT_NUMBER›')
  expect(d.mask('+44 20 7946 0958')).toBe('‹PHONE›')
})

test('secrets are masked, the surrounding code is kept', async () => {
  expect(d.mask('{"clientsecret": "abc123XYZ987"}')).toBe('{"clientsecret": "‹SECRET›"}')
  expect(d.mask("password = 'hunter2hunter2'")).toBe("password = '‹SECRET›'")
  expect(d.mask('export API_TOKEN=supersecretvalue')).toBe('export API_TOKEN=‹SECRET›')
  expect(d.mask('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe('Authorization: Bearer ‹TOKEN›')
  expect(d.mask('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).toBe('‹PRIVATE_KEY›')
  expect(d.mask('t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N')).toBe('t=‹TOKEN›')
})

test('ordinary code and allowed values pass unchanged', async () => {
  for (const s of [
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'see test@example.com',
    'const at = 1696852800000',
    'version 1.2.3 of @sap/cds',
    'password: string',
    'password = "${PASSWORD}"',
    'invoice 1234567890',
    'QQ 12 34 56 C',
  ]) expect(d.mask(s)).toBe(s)
})

test('a detector can be switched off, and a value kept', async () => {
  expect(new Detector({ phone: false }).mask('07700 900123')).toBe('07700 900123')
  expect(new Detector({}, ['ops@northwind.test']).mask('ops@northwind.test')).toBe('ops@northwind.test')
})

test('the leak check names the label, never the value', async () => {
  expect(d.leaks('reach me at jane.doe@northwind.test')).toEqual(['‹EMAIL›'])
  expect(d.leaks('already ‹EMAIL› and noreply@anthropic.com')).toEqual([])
})
