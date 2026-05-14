#!/bin/bash
# View deployment logs

echo "📂 Deployment Logs Viewer"
echo "=================================="
echo ""

# Check if deployment-logs directory exists
if [ ! -d "deployment-logs" ]; then
    echo "❌ No deployment logs found."
    echo "Run ./deploy.sh to create deployment logs."
    exit 1
fi

# Count total deployments
TOTAL=$(find deployment-logs -maxdepth 1 -mindepth 1 -type d | wc -l)
echo "📊 Total deployments: $TOTAL"
echo ""

# Show recent deployments
echo "📝 Recent deployments:"
echo "-----------------------------------"
ls -lt deployment-logs/ | head -6
echo ""

show_deployment() {
    local id="$1"
    local dir="deployment-logs/$id"
    if [ ! -d "$dir" ]; then
        echo "❌ Deployment '$id' not found."
        echo ""
        echo "Available deployments:"
        ls -1 deployment-logs/
        return 1
    fi

    echo "📄 Viewing deployment: $id"
    echo "=================================="
    echo ""

    if [ -f "$dir/deployment-summary.txt" ]; then
        cat "$dir/deployment-summary.txt"
        echo ""
    fi

    if [ -f "$dir/server.log" ]; then
        echo "Last 30 lines of server.log:"
        echo "-----------------------------------"
        tail -n 30 "$dir/server.log"
        echo ""
    fi

    if [ -f "$dir/migrate.log" ]; then
        echo "Last 20 lines of migrate.log:"
        echo "-----------------------------------"
        tail -n 20 "$dir/migrate.log"
        echo ""
    fi

    echo "Available log files in this deployment:"
    ls -1 "$dir/"
    echo ""
    echo "To view a specific log file:"
    echo "  cat $dir/<filename>"
    echo "To tail the live server log (only useful if this is the most recent deploy):"
    echo "  tail -f $dir/server.log"
}

if [ -z "$1" ]; then
    echo "💡 Usage:"
    echo "  ./view-logs.sh                    - List all deployments"
    echo "  ./view-logs.sh <timestamp>        - View specific deployment"
    echo "  ./view-logs.sh latest             - View latest deployment"
    LATEST_HINT=$(ls -t deployment-logs/ 2>/dev/null | head -1)
    if [ -n "$LATEST_HINT" ]; then
        echo ""
        echo "Example:"
        echo "  ./view-logs.sh $LATEST_HINT"
    fi
    exit 0
fi

if [ "$1" = "latest" ]; then
    LATEST=$(ls -t deployment-logs/ 2>/dev/null | head -1)
    if [ -n "$LATEST" ]; then
        show_deployment "$LATEST"
    else
        echo "❌ No deployments yet."
    fi
else
    show_deployment "$1"
fi
