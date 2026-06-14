#!/bin/bash
export MONO_IOMAP=all

# FIFO stdin: empêche Console.ReadLine() de recevoir EOF et de quitter le serveur
FIFO=/tmp/terraria-stdin
rm -f "$FIFO"
mkfifo "$FIFO"
exec 9<> "$FIFO"

cleanup() {
    kill "$SERVER_PID" 2>/dev/null
    exec 9>&-
    rm -f "$FIFO"
}
trap cleanup TERM INT

cd /opt/terraria/server
./TerrariaServer.bin.x86_64 -config /opt/terraria/serverconfig.txt < "$FIFO" &
SERVER_PID=$!
wait "$SERVER_PID"
STATUS=$?
exec 9>&-
rm -f "$FIFO"
exit $STATUS
