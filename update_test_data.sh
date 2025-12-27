#!/bin/bash
# Get base64 string, remove newlines to ensure it fits in a single line string
BASE64=$(base64 -i test/test-image.jpg | tr -d '\n')
echo "export const REAL_IMAGE_BASE64 = '$BASE64';" > test/test-image-data.ts
echo "Updated test/test-image-data.ts with base64 data from test/test-image.jpg"
