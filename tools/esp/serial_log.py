"""Print the device's log from its USB serial port for a while.

    uv run --with pyserial python -I tools/esp/serial_log.py COM3 30
    uv run --with pyserial python -I tools/esp/serial_log.py COM3 30 --reset

Opens the port without touching DTR/RTS, so the device keeps running. --reset
restarts it first (to see the boot log). The port disappears for a moment while
the chip resets; this waits for it to come back. Each line is prefixed with the
seconds since start.
"""
import argparse
import sys
import time

import serial


def open_port(name, deadline):
    while time.monotonic() < deadline:
        try:
            port = serial.Serial()
            port.port = name
            port.baudrate = 115200
            port.timeout = 0.2
            port.dtr = False
            port.rts = False
            port.open()
            return port
        except (serial.SerialException, OSError):
            time.sleep(0.2)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("seconds", type=float)
    ap.add_argument("--reset", action="store_true", help="restart the device first")
    args = ap.parse_args()

    start = time.monotonic()
    deadline = start + args.seconds
    port = open_port(args.port, deadline)
    if port is None:
        sys.exit(f"cannot open {args.port}")
    if args.reset:
        # USB Serial/JTAG: RTS high with DTR low holds the chip in reset.
        port.dtr = False
        port.rts = True
        time.sleep(0.1)
        port.rts = False
        port.close()
        time.sleep(0.5)
        port = open_port(args.port, deadline)
        if port is None:
            sys.exit(f"{args.port} did not come back after the reset")

    out = sys.stdout.buffer
    pending = b""
    while time.monotonic() < deadline:
        try:
            chunk = port.read(4096)
        except (serial.SerialException, OSError):
            port.close()
            out.write(f"[{time.monotonic() - start:6.1f}] -- port lost, reopening --\n".encode())
            port = open_port(args.port, deadline)
            if port is None:
                break
            continue
        if not chunk:
            continue
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for line in lines:
            out.write(f"[{time.monotonic() - start:6.1f}] ".encode() + line.rstrip(b"\r") + b"\n")
        out.flush()
    if pending:
        out.write(pending + b"\n")


if __name__ == "__main__":
    main()
