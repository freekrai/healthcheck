#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PM2=/usr/bin/pm2
DECL=prod.pm2.json
CUSER=travis

set -e
$PM2 startOrRestart $DIR/$DEC
