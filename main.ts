// ===== Cutebot + BLE UART Command Processor (TypeScript) =====
// Commands from app (newline-terminated): :SEQ,OP,ARGS*\n
// SEQ = 2 hex digits (00..FF), OP = MV|SP|TL|TR|BK|HL|BZ|EC
//
// ARGS:
//   MV,left,right         -> motors(left,right) -100..100 (negatives reverse)
//   SP,00                 -> stop
//   TL,00 / TR,00         -> turn left/right (instant)
//   BK,ss                 -> backward via motors(-ss,-ss); default 50
//   HL,01|00              -> headlights on/off (white)
//   HL,RR,GG,BB           -> headlights to RGB color (0..FF each)
//   BZ,HH,LL,DD           -> buzzer freq=(HH<<8)|LL Hz, dur=DD*10ms (DD=0->100ms)
//   EC,00                 -> echo/no-op
//
// Replies: :SEQ,ACK | :SEQ,BUSY | :SEQ,ERR,EC
// Telemetry pushes: #DIST,cc (cm), #LED,rrggbb, #BUZ,done

bluetooth.startUartService()

// ---------- UI feedback ----------
let bleConnected = false

bluetooth.onBluetoothConnected(function () {
    bleConnected = true
    basic.showIcon(IconNames.Heart)
})

bluetooth.onBluetoothDisconnected(function () {
    bleConnected = false
    basic.clearScreen()
    basic.showIcon(IconNames.SmallDiamond)
})

// --- Button A: show card name quickly ---
input.onButtonPressed(Button.A, function () {
    // display BLE device name quickly
    basic.showString(control.deviceName(), 50)
    // restore icon based on BLE state
    if (bleConnected) basic.showIcon(IconNames.Heart)
    else basic.showIcon(IconNames.SmallDiamond)
})

// ---------- types ----------
type Cmd = { s: number, o: string, a: number, b: number, c: number }

// ---------- helpers ----------
function hex2(n: number) {
    n &= 0xFF
    const d = "0123456789ABCDEF"
    return d.charAt((n >> 4) & 0xF) + d.charAt(n & 0xF)
}

function parseHexByte(s: string) {
    if (!s) return 0
    const t = s.trim().toUpperCase()
    if (t.length == 0) return 0
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

function clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v))
}

function send(line: string) { bluetooth.uartWriteString(line) }
function sendAck(seq: number) { send(":" + hex2(seq) + ",ACK\n") }
function sendBusy(seq: number) { send(":" + hex2(seq) + ",BUSY\n") }
function sendErr(seq: number, ec: number) { send(":" + hex2(seq) + ",ERR," + hex2(ec) + "\n") }

// ---------- queue ----------
const QDEPTH = 6
const q: Cmd[] = []
let busy = false

function qPush(c: Cmd) {
    if (q.length >= QDEPTH) return false
    q.push(c)
    return true
}
function qPop(): Cmd | null {
    if (q.length == 0) return null
    return q.shift()
}

// ---------- parser ----------
function parseLine(raw: string): Cmd | null {
    if (!raw) return null
    // MakeCode-safe: String.replace doesn't take RegExp; use split/join
    const line = raw.split("\r").join("").trim()
    if (line.length < 5) return null
    if (line.charAt(0) != ":") return null

    const core = line.substr(1).trim()
    const parts = core.split(",")
    if (parts.length < 2) return null

    const seq = parseInt(parts[0], 16)
    const op = (parts[1] || "").toUpperCase()
    const a = parts.length > 2 ? parseHexByte(parts[2]) : 0
    const b = parts.length > 3 ? parseHexByte(parts[3]) : 0
    const c = parts.length > 4 ? parseHexByte(parts[4]) : 0
    return { s: isNaN(seq) ? 0 : (seq & 0xFF), o: op, a: a, b: b, c: c }
}

// ---------- executor ----------
function runOne(cmd: Cmd, done: () => void) {
    switch (cmd.o) {
        case "MV": {
            const L = clamp(cmd.a, -100, 100)
            const R = clamp(cmd.b, -100, 100)
            cuteBot.motors(L, R)
            break
        }
        case "SP":
            cuteBot.stopcar()
            break
        case "TL":
            cuteBot.turnleft()
            break
        case "TR":
            cuteBot.turnright()
            break
        case "BK": {
            const spd = cmd.a > 0 ? clamp(cmd.a, 0, 100) : 50
            cuteBot.motors(-spd, -spd)
            break
        }
        case "HL": {
            if (cmd.b > 0 || cmd.c > 0) {
                const color = ((cmd.a & 0xFF) << 16) | ((cmd.b & 0xFF) << 8) | (cmd.c & 0xFF)
                cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
                const rr = hex2((color >> 16) & 0xFF)
                const gg = hex2((color >> 8) & 0xFF)
                const bb = hex2(color & 0xFF)
                send("#LED," + rr + gg + bb + "\n")
            } else {
                const on = (cmd.a & 0xFF) != 0
                const color = on ? 0xFFFFFF : 0x000000
                cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
                const rr = hex2((color >> 16) & 0xFF)
                const gg = hex2((color >> 8) & 0xFF)
                const bb = hex2(color & 0xFF)
                send("#LED," + rr + gg + bb + "\n")
            }
            break
        }
        case "BZ": {
            const freq = clamp(((cmd.a & 0xFF) << 8) | (cmd.b & 0xFF), 100, 5000)
            let dur = (cmd.c & 0xFF) * 10
            if (dur <= 0) dur = 100
            music.playTone(freq, dur)
            control.inBackground(() => {
                basic.pause(dur)
                send("#BUZ,done\n")
            })
            break
        }
        case "EC":
            break
        default:
            sendErr(cmd.s, 0x01)
            done()
            return
    }

    control.inBackground(() => {
        basic.pause(10)
        sendAck(cmd.s)
        done()
    })
}

function pump() {
    if (busy || q.length == 0) return
    busy = true
    const cmd: Cmd | null = qPop()
    if (!cmd) { busy = false; return }
    runOne(cmd, () => { busy = false; pump() })
}

// ---------- BLE receive ----------
bluetooth.onUartDataReceived("\n", function () {
    const raw = bluetooth.uartReadUntil("\n")
    const cmd: Cmd | null = parseLine(raw)
    if (!cmd) {
        sendErr(0x00, 0x02)
        return
    }
    if (busy && q.length >= QDEPTH) { sendBusy(cmd.s); return }
    if (!qPush(cmd)) { sendBusy(cmd.s); return }
    pump()
})

// ---------- telemetry loop ----------
loops.everyInterval(500, function () {
    const d = cuteBot.ultrasonic(cuteBot.SonarUnit.Centimeters)
    bluetooth.uartWriteString("#DIST," + d + "\n")
})