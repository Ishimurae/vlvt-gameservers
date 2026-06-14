#!/bin/bash
cd /opt/7dtd/server
exec ./7DaysToDieServer.x86_64 \
  -configfile=serverconfig.xml \
  -logfile /opt/7dtd/server/output_log.txt \
  -batchmode -nographics -dedicated
