#!/bin/sh
set -e

if [ ! -z "$ZIGBEE2MATTER_DATA" ]; then
    DATA="$ZIGBEE2MATTER_DATA"
else
    if [ ! -z "$ZIGBEE2MQTT_DATA" ]; then
        echo "WARNING: ZIGBEE2MQTT_DATA is ignored. Set ZIGBEE2MATTER_DATA and import existing data via the migration tool." >&2
    fi
    DATA="/app/data"
    export ZIGBEE2MATTER_DATA="$DATA"
fi

echo "Using '$DATA' as data directory"

exec "$@"
