// Shared by the detectors (detect.ts) and the model layer (model.ts).

// A digit run no one is given as a phone number: counting up or down
// (0123456789, as in code) or one digit repeated (00000000000).
export const trivialRun = (n: string) => {
  let up = true
  let down = true
  for (let i = 1; i < n.length; i++) {
    const d = (Number(n[i]) - Number(n[i - 1]) + 10) % 10
    if (d !== 1) up = false
    if (d !== 9) down = false
  }
  return up || down || /^(\d)\1+$/.test(n)
}
