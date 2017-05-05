#!/bin/bash

PM2=/usr/bin/pm2
DECL=deployment/prod.pm2.json
CUSER=travis

set -e
$PM2 list
