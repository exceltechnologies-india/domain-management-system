import { LucideIcon } from 'lucide-react';

interface QuickAction {
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
  color: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'indigo';
}

interface AdminQuickActionsProps {
  actions: QuickAction[];
}

const colorClasses = {
  blue: 'bg-blue-50 border-blue-200 text-blue-600 hover:bg-blue-100 hover:border-blue-300',
  green: 'bg-green-50 border-green-200 text-green-600 hover:bg-green-100 hover:border-green-300',
  yellow: 'bg-yellow-50 border-yellow-200 text-yellow-600 hover:bg-yellow-100 hover:border-yellow-300',
  red: 'bg-red-50 border-red-200 text-red-600 hover:bg-red-100 hover:border-red-300',
  purple: 'bg-purple-50 border-purple-200 text-purple-600 hover:bg-purple-100 hover:border-purple-300',
  indigo: 'bg-indigo-50 border-indigo-200 text-indigo-600 hover:bg-indigo-100 hover:border-indigo-300',
};

export default function AdminQuickActions({ actions }: AdminQuickActionsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {actions.map((action, index) => {
        const Icon = action.icon;
        return (
          <a
            key={index}
            href={action.href}
            className={`p-6 rounded-xl border-2 transition-all duration-200 transform hover:scale-105 hover:shadow-md ${colorClasses[action.color]}`}
          >
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <div className={`p-3 rounded-lg ${colorClasses[action.color].split(' ')[0]} mb-4`}>
                  <Icon className="h-6 w-6" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold mb-2">{action.title}</h3>
                <p className="text-sm opacity-90 leading-relaxed">{action.description}</p>
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}