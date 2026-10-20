#!/usr/bin/env python3
"""Extract only bounded regular files from a GitHub RC ZIP read from stdin."""
import io
import os
import stat
import sys
import zipfile

MAX_FILE = 384 * 1024 * 1024
MAX_TOTAL = 768 * 1024 * 1024
MAX_ARCHIVE = 256 * 1024 * 1024


def main():
    destination = sys.argv[1]
    data = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        raise ValueError('archive size limit exceeded')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if not 1 <= len(entries) <= 16:
            raise ValueError('invalid entry count')
        names = set()
        total = 0
        for entry in entries:
            name = entry.filename
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (not name or name in ('.', '..') or '/' in name or '\\' in name or '\x00' in name
                    or name in names or entry.is_dir() or kind not in (0, stat.S_IFREG)
                    or entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError('invalid archive entry')
            names.add(name)
            total += entry.file_size
            if (entry.file_size > MAX_FILE or total > MAX_TOTAL
                    or entry.file_size > max(1, entry.compress_size) * 500):
                raise ValueError('archive expansion limit exceeded')
        for entry in entries:
            with archive.open(entry) as source, open(os.path.join(destination, entry.filename), 'xb') as target:
                remaining = entry.file_size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('truncated archive entry')
                    target.write(chunk)
                    remaining -= len(chunk)
                if source.read(1):
                    raise ValueError('archive entry exceeds declared size')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print('Invalid release archive: ' + str(error), file=sys.stderr)
        sys.exit(1)
