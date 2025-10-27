// ===== Cutebot + BLE UART (Immediate Exec, semicolon-delimited, timed arrows, ECHO + descriptive ACKs) =====
//
// Command format (starts and ends with ';'):
//   ;SEQ,OP,ARG1,ARG2;
//
// Two-arg interface for movement & stop:
//   MV (forward)  : ARG1 = speed, ARG2 = duration (seconds)
//   BK (backward) : ARG1 = speed, ARG2 = duration (seconds)
//   TL (turn left): ARG1 = speed, ARG2 = duration (seconds)
//   TR (turn right):ARG1 = speed, ARG2 = duration (seconds)
//   SP (hard stop): ARG1 = 0, ARG2 = 0  (dummy args, same interface)
//
// Other:
//   HL (headlights): RGB or on/off (see code)
//   BZ (buzzer)    : freq hi, freq lo, duration*10ms
//   EC (echo)      : acknowledgment only
//
// Replies (newline-terminated):
//   #ECHO,<raw line>\n
//   ;SEQ,ACK,OP;\n     (or ;00,ACK,??;\n if parse failed)
//   #LED,rrggbb\n      (after HL)
//   #BUZ,done\n        (after BZ)
//
// Notes:
// - Arrows show only during the commanded movement duration, then revert to a wait icon.
// - No queue: executes each command immediately when received.

bluetooth.startUartService()

const DELIM = ";"  // semicolon delimiter

interface Cmd { s: number; o: string; a: number; b: number; c: number }

// ---------- UI helpers ----------
function showWait() {
    basic.showIcon(IconNames.SmallDiamond)
}
function showStopBrief() {
    basic.showIcon(IconNames.No)
    basic.pause(150)
    showWait()
}

// ---------- misc helpers ----------
function hex2(n: number) {
    n &= 0xFF
    const d = "0123456789ABCDEF"
    return d.charAt((n >> 4) & 0xF) + d.charAt(n & 0xF)
}
function parseHexByte(s: string) {
    const t = s ? s.trim().toUpperCase() : ""
    if (!t || t.length == 0) return 0
    let v = 0
    for (let i = 0; i < t.length && i < 2; i++) {
        const c = t.charCodeAt(i)
        let d = -1
        if (c >= 48 && c <= 57) d = c - 48
        else if (c >= 65 && c <= 70) d = c - 55
        if (d < 0) break
        v = (v << 4) | d
    }
    return v & 0xFF
}
function send(line: string) { bluetooth.uartWriteString(line) }
function sendAckWithOp(seq: number, opEcho: string) { send(DELIM + hex2(seq) + ",ACK," + opEcho + DELIM + "\n") }
function sendErr(seq: number, ec: number) { send(DELIM + hex2(seq) + ",ERR," + hex2(ec) + DELIM + "\n") }

function hardStop() {
    cuteBot.motors(0, 0)
    try { cuteBot.stopcar() } catch (e) { }
}

// ---------- parsing utilities ----------
function sanitize(raw: string): string {
    if (!raw) return ""
    let out = ""
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i)
        const ch = raw.charAt(i)
        if (code < 32) continue       // drop control chars
        if (ch == ";") continue       // drop stray delimiters
        out += ch
    }
    return out.trim()
}
function guessOp(raw: string): string {
    const clean = sanitize(raw)
    if (!clean) return "??"
    let s = clean
    if (s.charAt(0) == ";") s = s.substr(1)
    const parts = s.split(",")
    if (parts.length < 2) return "??"
    const op = parts[1].trim().toUpperCase()
    if (op == "MV" || op == "BK" || op == "TL" || op == "TR" || op == "SP" || op == "HL" || op == "BZ" || op == "EC")
        return op
    return "??"
}
function parseLine(line: string): Cmd {
    const clean = sanitize(line)
    if (!clean || clean.length < 2) return null
    let s = clean
    if (s.charAt(0) == ";") s = s.substr(1)
    const parts = s.split(",")
    if (parts.length < 2) return null
    const seqHex = parts[0]
    let seqNum = 0
    if (seqHex && seqHex.length > 0) {
        const tmp = parseInt(seqHex, 16)
        if (!isNaN(tmp)) seqNum = tmp & 0xFF
    }
    const op = (parts[1] || "").trim().toUpperCase()
    if (!op) return null
    const a = parts.length > 2 ? parseHexByte(parts[2]) : 0
    const b = parts.length > 3 ? parseHexByte(parts[3]) : 0
    const c = parts.length > 4 ? parseHexByte(parts[4]) : 0
    return { s: seqNum, o: op, a: a, b: b, c: c }
}

// ---------- executor ----------
function runNow(cmd: Cmd) {
    switch (cmd.o) {
        case "MV": { // forward (speed, duration)
            basic.showArrow(ArrowNames.South)
            cuteBot.moveTime(cuteBot.Direction.forward, cmd.a, cmd.b)
            showWait()
            break
        }
        case "BK": { // backward (speed, duration)
            basic.showArrow(ArrowNames.North)
            cuteBot.moveTime(cuteBot.Direction.backward, cmd.a, cmd.b)
            showWait()
            break
        }
        case "TL": { // left (speed, duration)
            basic.showArrow(ArrowNames.East)
            cuteBot.moveTime(cuteBot.Direction.left, cmd.a, cmd.b)
            showWait()
            break
        }
        case "TR": { // right (speed, duration)
            basic.showArrow(ArrowNames.West)
            cuteBot.moveTime(cuteBot.Direction.right, cmd.a, cmd.b)
            showWait()
            break
        }
        case "SP": { // hard stop (dummy args 0,0)
            hardStop()
            showStopBrief()
            break
        }
        case "HL": {
            let color: number
            if (cmd.b > 0 || cmd.c > 0) {
                color = ((cmd.a & 0xFF) << 16) | ((cmd.b & 0xFF) << 8) | (cmd.c & 0xFF)
                cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
            } else {
                color = cmd.a ? 0xFFFFFF : 0x000000
                cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
            }
            const rr = hex2((color >> 16) & 0xFF)
            const gg = hex2((color >> 8) & 0xFF)
            const bb = hex2(color & 0xFF)
            send("#LED," + rr + gg + bb + "\n")
            // keep wait icon; no change here
            break
        }
        case "BZ": {
            const freq = ((cmd.a & 0xFF) << 8) | (cmd.b & 0xFF)
            let dur = (cmd.c & 0xFF) * 10
            if (dur <= 0) dur = 100
            const f = Math.max(100, Math.min(5000, freq))
            music.playTone(f, dur)   // blocks for dur
            send("#BUZ,done\n")
            // keep wait icon; no change here
            break
        }
        case "EC":
            // no-Op; keep wait icon
            break
        default:
            sendErr(cmd.s, 0x01)
            return
    }
}

// ---------- BLE receive using ';' ----------
bluetooth.onUartDataReceived(DELIM, function () {
    const raw = bluetooth.uartReadUntil(DELIM) || ""
    send("#ECHO," + raw + "\n")
    const cmd = parseLine(raw)
    if (!cmd) { sendAckWithOp(0, guessOp(raw)); return }
    runNow(cmd)
    sendAckWithOp(cmd.s, cmd.o ? cmd.o : "??")
})

// Show wait icon on boot
showWait()