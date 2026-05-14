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
TOTAL=$(ls -1 deployment-logs/ | wc -l)
echo "📊 Total deployments: $TOTAL"
echo ""

# Show recent deployments
echo "📝 Recent deployments:"
echo "-----------------------------------"
ls -lt deployment-logs/ | head -6
echo ""

# If argument provided, show specific deployment
if [ -n "$1" ]; then
    if [ -d "deployment-logs/$1" ]; then
        echo "📄 Viewing deployment: $1"
        echo "=================================="
        echo ""
        
        # Show deployment summary
        if [ -f "deployment-logs/$1/deployment-summary.txt" ]; then
            cat "deployment-logs/$1/deployment-summary.txt"
            echo ""
        fi
        
        # Show PM2 status after deployment
        if [ -f "deployment-logs/$1/pm2-status-after-deploy.txt" ]; then
            echo "PM2 Status After Deployment:"
            echo "-----------------------------------"
            cat "deployment-logs/$1/pm2-status-after-deploy.txt"
            echo ""
        fi
        
        # Ask if user wants to see logs
        echo "Available log files in this deployment:"
        ls -1 "deployment-logs/$1/"
        echo ""
        echo "To view a specific log file, use:"
        echo "  cat deployment-logs/$1/<filename>"
    else
        echo "❌ Deployment '$1' not found."
        echo ""
        echo "Available deployments:"
        ls -1 deployment-logs/
    fi
else
    echo "💡 Usage:"
    echo "  ./view-logs.sh                    - List all deployments"
    echo "  ./view-logs.sh <timestamp>        - View specific deployment"
    echo "  ./view-logs.sh latest             - View latest deployment"
    echo ""
    echo "Example:"
    echo "  ./view-logs.sh $(ls -t deployment-logs/ | head -1)"
fi

# Handle 'latest' option
if [ "$1" = "latest" ]; then
    LATEST=$(ls -t deployment-logs/ | head -1)
    if [ -n "$LATEST" ]; then
        echo "📄 Latest deployment: $LATEST"
        echo "=================================="
        echo ""
        
        # Show deployment summary
        if [ -f "deployment-logs/$LATEST/deployment-summary.txt" ]; then
            cat "deployment-logs/$LATEST/deployment-summary.txt"
            echo ""
        fi
        
        # Show PM2 status
        if [ -f "deployment-logs/$LATEST/pm2-status-after-deploy.txt" ]; then
            echo "PM2 Status:"
            echo "-----------------------------------"
            cat "deployment-logs/$LATEST/pm2-status-after-deploy.txt"
            echo ""
        fi
        
        # Show last 20 lines of logs
        if [ -f "deployment-logs/$LATEST/pm2-logs-after-deploy.log" ]; then
            echo "Last 20 lines of PM2 logs:"
            echo "-----------------------------------"
            tail -20 "deployment-logs/$LATEST/pm2-logs-after-deploy.log"
        fi
    fi
fi