import { LucideIcon } from 'lucide-react';

interface Tab {
  id: string;
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
}

interface AdminTabsProps {
  tabs: Tab[];
  activeTab: string;
  className?: string;
}

export default function AdminTabs({ tabs, activeTab, className = '' }: AdminTabsProps) {
  return (
    <div className={`border-b border-gray-200 mb-8 ${className}`}>
      <nav className="-mb-px flex space-x-8">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={tab.onClick}
              className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center ${isActive
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <Icon className="h-5 w-5 mr-2" />
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
