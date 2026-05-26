"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { formatIndianDateTime } from '@/lib/dateUtils';
import { apiClient } from '@/lib/api-client';

interface IPData {
  success: boolean;
  message: string;
  data?: {
    primaryIP: string;
    allIPs: string[];
    timestamp: string;
    services: Record<string, any>;
  };
  error?: string;
}

export default function OutboundIPBadge() {
  const [ipData, setIpData] = useState<IPData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchIP = async () => {
      setLoading(true);
      setError(null);

      const result = await apiClient.get<IPData>('/api/v1/check-ip');
      if (result.ok) {
        if (result.data.success) {
          setIpData(result.data);
        } else {
          setError(result.data.message || 'Failed to fetch IP');
        }
      } else {
        setError(result.error.message);
      }
      setLoading(false);
    };

    void fetchIP();

    // Refresh IP every 30 minutes
    const interval = setInterval(fetchIP, 30 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Badge variant="outline" className="text-xs">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
          <span>Loading IP...</span>
        </div>
      </Badge>
    );
  }

  if (error || !ipData?.data?.primaryIP) {
    return (
      <Badge variant="destructive" className="text-xs">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-red-500 rounded-full"></div>
          <span>IP Error</span>
        </div>
      </Badge>
    );
  }

  const { primaryIP, allIPs, timestamp } = ipData.data;
  const isMultipleIPs = allIPs.length > 1;

  return (
    <Badge
      variant={isMultipleIPs ? "secondary" : "default"}
      className="text-xs cursor-help"
      title={`Outbound IP: ${primaryIP}${isMultipleIPs ? `\nAll IPs: ${allIPs.join(', ')}` : ''}\nLast checked: ${formatIndianDateTime(timestamp)}`}
    >
      <div className="flex items-center gap-1">
        <div className={`w-2 h-2 rounded-full ${isMultipleIPs ? 'bg-orange-500' : 'bg-green-500'}`}></div>
        <span className="font-mono">
          {primaryIP}
          {isMultipleIPs && <span className="text-orange-600">*</span>}
        </span>
      </div>
    </Badge>
  );
}
