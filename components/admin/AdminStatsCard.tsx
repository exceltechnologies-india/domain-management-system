import { LucideIcon, TrendingUp, TrendingDown } from 'lucide-react';

interface AdminStatsCardProps {
  title: string;
  value: string | number;
  change?: {
    value: string;
    type: 'increase' | 'decrease' | 'neutral';
  };
  icon: LucideIcon;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'indigo';
}

const colorClasses = {
  blue: {
    bg: 'bg-blue-500',
    light: 'bg-blue-50',
    text: 'text-blue-600',
    icon: 'text-blue-500'
  },
  green: {
    bg: 'bg-green-500',
    light: 'bg-green-50',
    text: 'text-green-600',
    icon: 'text-green-500'
  },
  yellow: {
    bg: 'bg-yellow-500',
    light: 'bg-yellow-50',
    text: 'text-yellow-600',
    icon: 'text-yellow-500'
  },
  red: {
    bg: 'bg-red-500',
    light: 'bg-red-50',
    text: 'text-red-600',
    icon: 'text-red-500'
  },
  purple: {
    bg: 'bg-purple-500',
    light: 'bg-purple-50',
    text: 'text-purple-600',
    icon: 'text-purple-500'
  },
  indigo: {
    bg: 'bg-indigo-500',
    light: 'bg-indigo-50',
    text: 'text-indigo-600',
    icon: 'text-indigo-500'
  }
};

export default function AdminStatsCard({
  title,
  value,
  change,
  icon: Icon,
  color = 'blue'
}: AdminStatsCardProps) {
  const colors = colorClasses[color];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-600 mb-1">{title}</p>
          <p className="text-3xl font-bold text-gray-900 mb-2">{value}</p>
          {change && (
            <div className="flex items-center">
              {change.type === 'increase' ? (
                <TrendingUp className="h-4 w-4 text-green-500 mr-1" />
              ) : change.type === 'decrease' ? (
                <TrendingDown className="h-4 w-4 text-red-500 mr-1" />
              ) : null}
              <span className={`text-sm font-medium ${change.type === 'increase' ? 'text-green-600' :
                  change.type === 'decrease' ? 'text-red-600' :
                    'text-gray-600'
                }`}>
                {change.value}
              </span>
              <span className="text-sm text-gray-500 ml-1">vs last month</span>
            </div>
          )}
        </div>
        <div className={`p-3 rounded-xl ${colors.light}`}>
          <Icon className={`h-6 w-6 ${colors.icon}`} />
        </div>
      </div>
    </div>
  );
}