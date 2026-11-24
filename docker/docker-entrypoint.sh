#!/bin/sh
set -e

if [ ! -z "$ZIGBEE2MATTER_DATA" ]; then
    DATA="$ZIGBEE2MATTER_DATA"
elif [ ! -z "$ZIGBEE2MQTT_DATA" ]; then
    DATA="$ZIGBEE2MQTT_DATA"
else
    DATA="/app/data"
fi

echo "Using '$DATA' as data directory"

exec "$@"
