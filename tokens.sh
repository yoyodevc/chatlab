#!/bin/bash
# Usage: source ./tokens.sh   (sets TOKEN for bob and CT for carol)
get() {
  curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/'
}
TOKEN=$(get bob bob-pass-2)
CT=$(get carol carol-pass-3)
echo "bob token:   ${TOKEN:0:15}..."
echo "carol token: ${CT:0:15}..."
