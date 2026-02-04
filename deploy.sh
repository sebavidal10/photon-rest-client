#!/bin/bash

# Load environment variables from .env
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

if [ -z "$OVSX_PAT" ]; then
    echo "❌ Error: OVSX_PAT is not set in .env"
    exit 1
fi

VERSION=$(node -p "require('./package.json').version")
VSIX_FILE="photon-rest-client-$VERSION.vsix"

echo "🚀 Deploying $VSIX_FILE to Open VSX..."

if [ -f "$VSIX_FILE" ]; then
    npx ovsx publish "$VSIX_FILE" --pat "$OVSX_PAT"
else
    echo "❌ Error: $VSIX_FILE not found. Run 'npm run package' first."
    exit 1
fi
