#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# usage: S3_BUCKET=vdrkit PUBLIC_URL=https://dataroom.example.com sh scripts/s3-bucket-setup.sh
# env: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, QUARANTINE_DAYS=1, CREATE_BUCKET=1
# Overwrites the bucket's CORS and lifecycle rules.
# MinIO has no bucket CORS; set MINIO_API_CORS_ALLOW_ORIGIN instead
set -eu

: "${S3_BUCKET:?Set S3_BUCKET to the bucket name.}"
: "${PUBLIC_URL:?Set PUBLIC_URL to the address people use, for example https://dataroom.example.com}"
QUARANTINE_DAYS="${QUARANTINE_DAYS:-1}"
REGION="${S3_REGION:-us-east-1}"
ORIGIN=$(printf '%s' "$PUBLIC_URL" | sed 's:/*$::')
case "$QUARANTINE_DAYS" in ''|*[!0-9]*) echo "QUARANTINE_DAYS must be a whole number of days." >&2; exit 2 ;; esac
DAYS=days; [ "$QUARANTINE_DAYS" = 1 ] && DAYS=day

WORK=$(mktemp -d)
# Docker/aws.exe can't read Git Bash /tmp paths
HOST_WORK="$WORK"
if command -v cygpath >/dev/null 2>&1; then HOST_WORK=$(cygpath -m "$WORK"); fi
trap 'rm -f "$WORK/cors.json" "$WORK/lifecycle.json" "$WORK/quarantine-only.json" "$WORK/out.txt"; rmdir "$WORK"' EXIT

cat > "$WORK/cors.json" <<EOF
{"CORSRules":[{"ID":"vdrkit-browser-uploads","AllowedOrigins":["$ORIGIN"],"AllowedMethods":["PUT"],
  "AllowedHeaders":["content-type"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]}
EOF
# on a versioned bucket a delete leaves the unencrypted upload behind as an old version
OLD_VERSIONS=',"NoncurrentVersionExpiration":{"NoncurrentDays":1}'
write_lifecycle() {
  quarantine="{\"ID\":\"vdrkit-quarantine\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"quarantine/\"},\"Expiration\":{\"Days\":$QUARANTINE_DAYS}$1}"
  cat > "$WORK/lifecycle.json" <<EOF
{"Rules":[
  $quarantine,
  {"ID":"vdrkit-abort-unfinished-uploads","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}
EOF
  printf '{"Rules":[%s]}\n' "$quarantine" > "$WORK/quarantine-only.json"
}

export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}"
export AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}"
export AWS_DEFAULT_REGION="$REGION"
s3api() {
  if command -v aws >/dev/null 2>&1; then
    aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3api "$@"
  else
    MSYS_NO_PATHCONV=1 docker run --rm ${AWS_CLI_DOCKER_NETWORK:+--network "$AWS_CLI_DOCKER_NETWORK"} \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION -v "$HOST_WORK:/work:ro" \
      amazon/aws-cli:2.22.35 ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3api "$@"
  fi
}
file() { if command -v aws >/dev/null 2>&1; then echo "file://$HOST_WORK/$1"; else echo "file:///work/$1"; fi; }

if [ "${CREATE_BUCKET:-0}" = "1" ]; then
  if s3api head-bucket --bucket "$S3_BUCKET" >/dev/null 2>&1; then
    echo "Bucket $S3_BUCKET exists."
  else
    s3api create-bucket --bucket "$S3_BUCKET" >/dev/null
    echo "Created bucket $S3_BUCKET."
  fi
fi

minio_note=""
if s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration "$(file cors.json)" >"$WORK/out.txt" 2>&1; then
  echo "CORS: PUT from $ORIGIN, ETag readable."
elif grep -q NotImplemented "$WORK/out.txt"; then
  echo "CORS: this store does not take bucket CORS rules (MinIO). Set MINIO_API_CORS_ALLOW_ORIGIN=$ORIGIN on the MinIO server."
  minio_note=1
else
  cat "$WORK/out.txt" >&2; exit 1
fi

put_lifecycle() {
  write_lifecycle "$1"
  if s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET" --lifecycle-configuration "$(file lifecycle.json)" >"$WORK/out.txt" 2>&1 \
     && s3api get-bucket-lifecycle-configuration --bucket "$S3_BUCKET" 2>/dev/null | grep -q AbortIncompleteMultipartUpload; then
    lifecycle=full
  elif s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET" --lifecycle-configuration "$(file quarantine-only.json)" >"$WORK/out.txt" 2>&1; then
    lifecycle=quarantine
  else
    return 1
  fi
}

# Garage and others drop the old-versions rule silently; only safe without it if unversioned
versioned() { s3api get-bucket-versioning --bucket "$S3_BUCKET" 2>/dev/null | grep -Eq 'Enabled|Suspended'; }
kept() { s3api get-bucket-lifecycle-configuration --bucket "$S3_BUCKET" 2>/dev/null | grep -q NoncurrentVersionExpiration; }
no_versions_note="           This store does not take the rule for old versions. Leave versioning off on this bucket."
if put_lifecycle "$OLD_VERSIONS"; then
  if kept; then
    versions_note="           Old versions under quarantine/ are removed after 1 day."
  elif versioned; then
    echo "The store accepted the rule for old versions under quarantine/ and did not keep it. On this versioned bucket," >&2
    echo "unencrypted uploads would stay for good. Turn versioning off or use a store that takes the rule." >&2
    exit 1
  else
    versions_note="$no_versions_note"
  fi
elif ! versioned && put_lifecycle ""; then
  versions_note="$no_versions_note"
else
  cat "$WORK/out.txt" >&2; exit 1
fi
if [ "$lifecycle" = full ]; then
  echo "Lifecycle: quarantine/ cleared after $QUARANTINE_DAYS $DAYS, unfinished uploads aborted after 1 day."
  echo "$versions_note"
else
  echo "Lifecycle: quarantine/ cleared after $QUARANTINE_DAYS $DAYS. This store does not take the rule for unfinished uploads (MinIO):"
  echo "           MinIO removes them itself after MINIO_API_STALE_UPLOADS_EXPIRY (24h by default)."
  echo "$versions_note"
  minio_note=1
fi

echo "Settings now on $S3_BUCKET:"
s3api get-bucket-cors --bucket "$S3_BUCKET" 2>/dev/null || [ -n "$minio_note" ]
s3api get-bucket-lifecycle-configuration --bucket "$S3_BUCKET"
