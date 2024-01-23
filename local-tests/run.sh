#!/bin/bash

LOCAL_TEST_FOLDER=local-tests
PARENT_FOLDER="$(git rev-parse --show-toplevel)"
GH_TOKEN=`cat $LOCAL_TEST_FOLDER/.token`

cd "$PARENT_FOLDER"
pwd

SELF_HOSTED=catthehacker/ubuntu:act-22.04
TEMP_DIR=test-out

act \
	-s GITHUB_TOKEN="$GH_TOKEN" \
    -W "$LOCAL_TEST_FOLDER" \
    --container-architecture linux/arm64 \
	--var-file "$LOCAL_TEST_FOLDER/global.variables" \
	--secret-file "$LOCAL_TEST_FOLDER/global.secrets" \
	-P self-hosted="$SELF_HOSTED" \
	--artifact-server-path "$TEMP_DIR" \
	"$@"
