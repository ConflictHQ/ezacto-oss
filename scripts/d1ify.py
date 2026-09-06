#!/usr/bin/env python3
"""Rewrite a `sqlite3 .dump` into a file hosted D1 will accept.

D1's remote importer rejects two constructs a modern sqlite3 CLI emits, and a
local rehearsal cannot find either: local sqlite3 wrote them, so it reads them
back happily.

1. The `BEGIN TRANSACTION;` / `COMMIT;` wrapper. Remote import answers "To
   execute a transaction, please use the state.storage.transaction() ... APIs
   instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements". wrangler does
   strip this, but only on the `--local` path; the remote path uploads the file
   byte for byte.

2. `unistr('...\\u000d\\u000a...')` literals, which sqlite3 3.51 emits for any
   TEXT value holding a control character. Remote import answers "not
   authorized to use function: unistr".

Each `unistr()` call is re-emitted as `CAST(X'<utf8 hex>' AS TEXT)`: byte-exact,
free of quoting hazards, and it keeps every statement on one line. Decoding back
to raw characters instead is NOT safe — the sqlite3 CLI strips CR when re-reading
a script, so a CRLF inside a value would be silently lost.

The wrapper is removed by position, never by search: only a `BEGIN TRANSACTION;`
in the dump header and a trailing `COMMIT;` are dropped, so a TEXT value that
happens to contain either keyword is left alone. Nothing is written unless the
result is free of both rejected constructs and of lines above D1's 100 KB
statement ceiling. That check is per line, which is the right unit here: after
the rewrite every INSERT occupies exactly one line, and the multi-line DDL a
dump emits is orders of magnitude below the ceiling. The `unistr(` guard is
deliberately conservative: it refuses a file whose data legitimately contains
that text rather than risk shipping a call.

usage: d1ify.py <dump.sql> <out.sql>
"""

import sys

# D1 rejects every one of these, wherever it appears in an imported file.
TRANSACTION_CONTROL = (
    "BEGIN TRANSACTION",
    "BEGIN;",
    "BEGIN DEFERRED",
    "BEGIN IMMEDIATE",
    "BEGIN EXCLUSIVE",
    "COMMIT",
    "END TRANSACTION",
    "ROLLBACK",
    "SAVEPOINT ",
    "RELEASE ",
)

# A statement above this is refused by D1's importer, so refuse it here instead
# of halfway through an upload.
STATEMENT_LIMIT_BYTES = 100_000

# `.dump` writes `PRAGMA foreign_keys=OFF;` then `BEGIN TRANSACTION;`. Allow a
# little slack for other pragmas without letting the search reach the data.
HEADER_LINES = 5


def fail(message):
    raise SystemExit(f"d1ify: {message}")


def rewrite_unistr(source):
    """Replace every unistr('...') call with a byte-exact hex literal."""
    parts, index, total, count = [], 0, len(source), 0
    while True:
        start = source.find("unistr('", index)
        if start == -1:
            parts.append(source[index:])
            return "".join(parts), count
        parts.append(source[index:start])
        cursor, literal = start + 8, []
        while True:
            if cursor >= total:
                fail(f"unterminated unistr() literal at offset {start}")
            char = source[cursor]
            if char == "'":
                if cursor + 1 < total and source[cursor + 1] == "'":
                    literal.append("'")
                    cursor += 2
                    continue
                cursor += 1
                break
            literal.append(char)
            cursor += 1
        if cursor >= total or source[cursor] != ")":
            fail(f"unistr() literal at offset {start} is not closed by ')'")
        cursor += 1
        text = decode_unistr("".join(literal), start)
        parts.append("CAST(X'" + text.encode("utf-8").hex() + "' AS TEXT)")
        count += 1
        index = cursor


def decode_unistr(body, offset):
    """Resolve unistr()'s \\uXXXX / \\UXXXXXXXX / \\\\ escapes to characters."""
    out, index, total = [], 0, len(body)
    while index < total:
        char = body[index]
        if char == "\\" and index + 1 < total:
            escape = body[index + 1]
            if escape == "\\":
                out.append("\\")
                index += 2
                continue
            if escape in ("u", "U"):
                width = 4 if escape == "u" else 8
                digits = body[index + 2 : index + 2 + width]
                if len(digits) != width:
                    fail(f"truncated \\{escape} escape at offset {offset}")
                try:
                    out.append(chr(int(digits, 16)))
                except ValueError:
                    fail(f"invalid \\{escape}{digits} escape at offset {offset}")
                index += 2 + width
                continue
        out.append(char)
        index += 1
    return "".join(out)


def strip_transaction_wrapper(lines):
    """Drop the dump's own BEGIN/COMMIT, anchored to first and last line."""
    stripped = 0
    for index in range(min(HEADER_LINES, len(lines))):
        if lines[index].strip() == "BEGIN TRANSACTION;":
            del lines[index]
            stripped += 1
            break
    last = len(lines) - 1
    while last >= 0 and lines[last].strip() == "":
        last -= 1
    if last >= 0 and lines[last].strip() == "COMMIT;":
        del lines[last]
        stripped += 1
    return lines, stripped


def offending_line(lines):
    """The first line D1 would reject, as (number, reason), or None."""
    for number, line in enumerate(lines, 1):
        statement = line.lstrip().upper()
        for keyword in TRANSACTION_CONTROL:
            if statement.startswith(keyword):
                return number, f"transaction control: {line.strip()[:60]}"
        if "unistr(" in line:
            return number, "unrewritten unistr( call"
        if len(line.encode("utf-8")) > STATEMENT_LIMIT_BYTES:
            return number, (
                f"line is {len(line.encode('utf-8'))} bytes, above D1's "
                f"{STATEMENT_LIMIT_BYTES}-byte statement ceiling"
            )
    return None


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: d1ify.py <dump.sql> <out.sql>")
    source_path, output_path = argv[1], argv[2]

    with open(source_path, encoding="utf-8", newline="") as handle:
        source = handle.read()

    rewritten, rewrites = rewrite_unistr(source)
    lines, stripped = strip_transaction_wrapper(rewritten.split("\n"))

    offence = offending_line(lines)
    if offence is not None:
        number, reason = offence
        fail(f"refusing to write {output_path}: line {number}, {reason}")

    with open(output_path, "w", encoding="utf-8", newline="") as handle:
        handle.write("\n".join(lines))

    longest = max(len(line.encode("utf-8")) for line in lines)
    print(
        f"rewrote {rewrites} unistr() call(s); stripped {stripped} transaction "
        f"control line(s); longest line {longest} bytes, under D1's "
        f"{STATEMENT_LIMIT_BYTES}-byte statement ceiling"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
