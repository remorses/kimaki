#!/bin/bash
# DEPRECATED: This script is no longer needed!
# 
# Kimaki is now available globally as `kimaki` command.
# Parakeet is the default ASR provider - no environment variables needed.
#
# Quick start:
#   1. Start ASR service: cd asr-service && python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
#   2. Run kimaki: kimaki
#
# See README_PARAKEET_SETUP.md for details.

echo "⚠️  DEPRECATED: start-kimaki.sh is no longer needed!"
echo ""
echo "Just run: kimaki"
echo ""
echo "For voice support, start the ASR service first:"
echo "  cd asr-service && python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765"
echo ""
read -p "Press Enter to continue with 'kimaki' anyway, or Ctrl+C to cancel..."

# Just run kimaki directly
exec kimaki "$@"
