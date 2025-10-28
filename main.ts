// ===== Cutebot + BLE UART Control (Timed Commands + GO opcode + tracking telemetry) =====
//
// 🧩 Command Protocol
// -------------------
// Each command starts and ends with ';'
//   ;SEQ,OP,ARG1,ARG2;
//
// Two-argument interface for movement & stop (ARG2 now in milliseconds):
//   MV (Move Forward) : ARG1 = speed (0–100), ARG2 = duration (ms)
//   BK (Move Backward): ARG1 = speed (0–100), ARG2 = duration (ms)
//   TL (Turn Left)    : ARG1 = speed (0–100), ARG2 = duration (ms)
//   TR (Turn Right)   : ARG1 = speed (0–100), ARG2 = duration (ms)
//   SP (Hard Stop)    : ARG1 = 0, ARG2 = 0 (dummy arguments)
//
// New opcode:
//   GO (Timed Run)    : ARG1 = speed (0–100), ARG2 = duration (ms)
//       → Starts both motors at ARG1 speed. After ARG2 ms, stops abruptly,
//         sends #TRK telemetry, and returns to the wait icon.
//
// Other commands:
//   HL (Headlights)   : RGB or on/off (see code)
//   BZ (Buzzer)       : freq-hi, freq-lo, duration*10ms
//   EC (Echo)         : test/no-op (no response)
//
// 🧾 Responses
// ------------
//   #TRK,<n>\n        Tracking telemetry (sent at startup and after each move/stop/GO)
//   #ERROR,<text>\n   On bad opcode or parse failure
//
// Tracking state (#TRK values):
//   0 = none, 1 = right only, 2 = left only, 3 = both sensors active
//
// 🧠 Notes
// --------
// - ARG2 values are interpreted as milliseconds (converted to seconds where needed).
// - The GO command uses a software timer to enforce duration-based stopping.
// - Only two message types are sent: #TRK and #ERROR.
// - Tracking state is sent at startup and after any motion command or stop.
//
// ---------------------------------------------------------------------------

bluetooth.startUartService()

// Command delimiter
const DELIM = ";"

// Cutebot line tracking sensors (active-low)
const TRACK_RIGHT = DigitalPin.P13
const TRACK_LEFT = DigitalPin.P14

// Track GO timer state
let goTimerActive = false
let goEndTime = 0

// Command structure
interface Cmd {
    s: number  // sequence number
    o: string  // operation code
    a: number  // argument 1 (speed/value)
    b: number  // argument 2 (duration/value)
    c: number  // optional argument 3 (for HL/BZ)
}

// ===========================================================
//  DISPLAY HELPERS
// ===========================================================

/** Shows a small neutral "wait" icon when idle. */
function showWait() {
    basic.showIcon(IconNames.SmallDiamond)
}

/** Briefly shows a stop icon before reverting to wait. */
function showStopBrief() {
    basic.showIcon(IconNames.No)
    basic.pause(150)
    showWait()
}

// ===========================================================
//  TRACKING TELEMETRY
// ===========================================================

/**
 * Reads both line-tracking sensors.
 * Returns a 2-bit encoded value:
 *   0 = none, 1 = right only, 2 = left only, 3 = both active.
 */
function readTracking(): number {
    const rActive = pins.digitalReadPin(TRACK_RIGHT) == 0 ? 1 : 0
    const lActive = pins.digitalReadPin(TRACK_LEFT) == 0 ? 1 : 0
    return (rActive ? 1 : 0) | (lActive ? 2 : 0)
}

/** Sends current tracking state over Bluetooth (#TRK,<n>). */
function sendTracking() {
    const t = readTracking()
    bluetooth.uartWriteString("#TRK," + t + "\n")
}

/** Sends an error message over Bluetooth (#ERROR,<text>). */
function sendError(code: string) {
    bluetooth.uartWriteString("#ERROR," + code + "\n")
}

// ===========================================================
//  UTILITY FUNCTIONS
// ===========================================================

/** Parses a 1–2 digit hex string into an integer (0–255). */
function parseHexByte(s: string): number {
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

/** Removes stray delimiters and non-printable characters from incoming strings. */
function sanitize(raw: string): string {
    if (!raw) return ""
    let out = ""
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i)
        const ch = raw.charAt(i)
        if (code < 32) continue
        if (ch == ";") continue
        out += ch
    }
    return out.trim()
}

/** Parses a command line into structured Cmd data. Returns null on failure. */
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
    const a = parts.length > 2 ? parseHexByte(parts[2]) : 0
    const b = parts.length > 3 ? parseHexByte(parts[3]) : 0
    const c = parts.length > 4 ? parseHexByte(parts[4]) : 0
    return { s: seqNum, o: op, a: a, b: b, c: c }
}

/** Immediately halts all motor motion and clears any GO timer. */
function hardStop() {
    cuteBot.motors(0, 0)
    try { cuteBot.stopcar() } catch (e) { }
    goTimerActive = false
    showStopBrief()
}

// ===========================================================
//  COMMAND EXECUTION LOGIC
// ===========================================================

/**
 * Executes a single parsed command.
 * - Movement commands convert ms→s internally.
 * - GO uses an asynchronous timer check.
 */
function runNow(cmd: Cmd) {
    switch (cmd.o) {
        case "MV": // Forward (milliseconds → seconds)
            basic.showArrow(ArrowNames.South)
            cuteBot.moveTime(cuteBot.Direction.forward, cmd.a, cmd.b / 1000)
            showWait()
            sendTracking()
            break

        case "BK": // Backward
            basic.showArrow(ArrowNames.North)
            cuteBot.moveTime(cuteBot.Direction.backward, cmd.a, cmd.b / 1000)
            showWait()
            sendTracking()
            break

        case "TL": // Turn Left
            basic.showArrow(ArrowNames.East)
            cuteBot.moveTime(cuteBot.Direction.left, cmd.a, cmd.b / 1000)
            showWait()
            sendTracking()
            break

        case "TR": // Turn Right
            basic.showArrow(ArrowNames.West)
            cuteBot.moveTime(cuteBot.Direction.right, cmd.a, cmd.b / 1000)
            showWait()
            sendTracking()
            break

        case "SP": // Hard Stop
            hardStop()
            sendTracking()
            break

        case "GO": // Continuous Run (timed)
            if (cmd.a == 0 || cmd.b == 0) {
                hardStop()
                sendError("GO_INVALID_ARGS")
                break
            }
            basic.showArrow(ArrowNames.South)
            cuteBot.motors(cmd.a, cmd.a)
            goTimerActive = true
            goEndTime = input.runningTime() + cmd.b
            break

        case "HL": { // Headlights (RGB or on/off)
            let color: number
            if (cmd.b > 0 || cmd.c > 0) {
                color = ((cmd.a & 0xFF) << 16) | ((cmd.b & 0xFF) << 8) | (cmd.c & 0xFF)
                cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
            } else {
                color = cmd.a ? 0xFFFFFF : 0x000000
                cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
            }
            break
        }

        case "BZ": { // Buzzer
            const freq = ((cmd.a & 0xFF) << 8) | (cmd.b & 0xFF)
            let dur = (cmd.c & 0xFF) * 10
            if (dur <= 0) dur = 100
            const f = Math.max(100, Math.min(5000, freq))
            music.playTone(f, dur)
            break
        }

        case "EC": // Echo / no-op
            break

        default:
            sendError("UNKNOWN_OP_" + cmd.o)
            return
    }
}

// ===========================================================
//  GO TIMER POLLING LOOP
// ===========================================================

/**
 * Every 100ms, checks whether the GO timer has expired.
 * If yes, stops the motors, sends #TRK telemetry, and clears the timer.
 */
loops.everyInterval(100, function () {
    if (goTimerActive && input.runningTime() >= goEndTime) {
        hardStop()
        sendTracking()
        goTimerActive = false
    }
})

// ===========================================================
//  BLUETOOTH UART HANDLER
// ===========================================================

/**
 * Handles incoming UART data terminated by ';'.
 * Ignores empty segments caused by leading semicolons.
 * On valid commands, executes immediately.
 */
bluetooth.onUartDataReceived(DELIM, function () {
    const raw = bluetooth.uartReadUntil(DELIM) || ""
    const trimmed = raw.trim()
    if (trimmed.length == 0) return

    const cmd = parseLine(raw)
    if (!cmd) {
        sendError("PARSE_FAIL")
        return
    }
    runNow(cmd)
})

// ===========================================================
//  STARTUP SEQUENCE
// ===========================================================

showWait()
sendTracking()