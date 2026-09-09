#!/bin/sh
docker exec n8n-db psql -U n8n -d n8n -c "SELECT id, status, \"startedAt\", \"stoppedAt\" FROM execution_entity ORDER BY id DESC LIMIT 10;"
