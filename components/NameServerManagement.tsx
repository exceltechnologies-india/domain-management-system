'use client';

import { useState, useEffect } from 'react';
import { Settings, Save, RotateCcw, Plus, Trash2, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { safeLocalStorage } from '@/lib/storage';

interface NameServerConfig {
  id: string;
  name: string;
  servers: string[];
  isDefault: boolean;
  isActive: boolean;
}

const RESELLERCLUB_DEFAULT = {
  id: 'default-nameservers',
  name: 'Default Nameservers',
  servers: [
    'deepak1299294.mercury.orderbox-dns.com',
    'deepak1299294.venus.orderbox-dns.com',
    'deepak1299294.earth.orderbox-dns.com',
    'deepak1299294.mars.orderbox-dns.com'
  ],
  isDefault: true,
  isActive: true,
};

export default function NameServerManagement() {
  const [configs, setConfigs] = useState<NameServerConfig[]>([]);
  const [editingConfig, setEditingConfig] = useState<NameServerConfig | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newConfig, setNewConfig] = useState<Omit<NameServerConfig, 'id'>>({
    name: '',
    servers: ['', ''],
    isDefault: false,
    isActive: true,
  });

  // Load nameserver configurations from localStorage
  useEffect(() => {
    const savedConfigs = safeLocalStorage.getItem('nameserverConfigs');
    if (savedConfigs) {
      try {
        const parsed = JSON.parse(savedConfigs);
        setConfigs([RESELLERCLUB_DEFAULT, ...parsed]);
      } catch (error) {
        // Failed to load nameserver configs
        setConfigs([RESELLERCLUB_DEFAULT]);
      }
    } else {
      setConfigs([RESELLERCLUB_DEFAULT]);
    }
  }, []);

  // Save configurations to localStorage
  const saveConfigs = (newConfigs: NameServerConfig[]) => {
    const customConfigs = newConfigs.filter(config => !config.isDefault);
    safeLocalStorage.setItem('nameserverConfigs', JSON.stringify(customConfigs));
    setConfigs(newConfigs);
  };

  const handleAddServer = () => {
    setNewConfig(prev => ({
      ...prev,
      servers: [...prev.servers, '']
    }));
  };

  const handleRemoveServer = (index: number) => {
    if (newConfig.servers.length > 1) {
      setNewConfig(prev => ({
        ...prev,
        servers: prev.servers.filter((_, i) => i !== index)
      }));
    }
  };

  const handleServerChange = (index: number, value: string) => {
    setNewConfig(prev => ({
      ...prev,
      servers: prev.servers.map((server, i) => i === index ? value : server)
    }));
  };

  const handleSaveNew = () => {
    if (!newConfig.name.trim()) {
      toast.error('Please enter a configuration name');
      return;
    }

    const validServers = newConfig.servers.filter(server => server.trim());
    if (validServers.length === 0) {
      toast.error('Please enter at least one nameserver');
      return;
    }

    const config: NameServerConfig = {
      ...newConfig,
      id: `custom-${Date.now()}`,
      servers: validServers,
    };

    const updatedConfigs = [...configs, config];
    saveConfigs(updatedConfigs);
    setNewConfig({ name: '', servers: ['', ''], isDefault: false, isActive: true });
    setIsAddingNew(false);
    toast.success('Nameserver configuration saved');
  };

  const handleSetActive = (configId: string) => {
    const updatedConfigs = configs.map(config => ({
      ...config,
      isActive: config.id === configId
    }));
    saveConfigs(updatedConfigs);
    toast.success('Active nameserver configuration updated');
  };

  const handleDelete = (configId: string) => {
    if (configs.find(c => c.id === configId)?.isDefault) {
      toast.error('Cannot delete default configuration');
      return;
    }

    const updatedConfigs = configs.filter(config => config.id !== configId);
    saveConfigs(updatedConfigs);
    toast.success('Nameserver configuration deleted');
  };

  const handleResetToDefault = () => {
    const updatedConfigs = configs.map(config => ({
      ...config,
      isActive: config.isDefault
    }));
    saveConfigs(updatedConfigs);
    toast.success('Reset to default nameservers');
  };

  const activeConfig = configs.find(config => config.isActive) || RESELLERCLUB_DEFAULT;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Settings className="w-5 h-5 text-[var(--google-blue)]" />
          <h2 className="text-xl font-semibold text-[var(--google-text-primary)]" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
            Nameserver Management
          </h2>
        </div>
        <button
          onClick={() => setIsAddingNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--google-blue)] text-white rounded-lg hover:bg-[var(--google-blue-dark)] transition-colors"
          style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
        >
          <Plus className="w-4 h-4" />
          Add Custom
        </button>
      </div>

      {/* Current Active Configuration */}
      <div className="mb-6 p-4 bg-[var(--google-bg-secondary)] rounded-lg border border-[var(--google-border)]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-[var(--google-text-primary)]" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
            Currently Active
          </h3>
          <span className="px-2 py-1 text-xs font-medium text-white bg-green-500 rounded-full">
            Active
          </span>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--google-text-primary)]" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
            {activeConfig.name}
          </p>
          <div className="flex flex-wrap gap-2">
            {activeConfig.servers.map((server, index) => (
              <span
                key={index}
                className="px-3 py-1 text-sm bg-white border border-gray-200 rounded-md text-[var(--google-text-secondary)]"
                style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
              >
                {server}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Add New Configuration */}
      {isAddingNew && (
        <div className="mb-6 p-4 border-2 border-dashed border-[var(--google-blue)] rounded-lg">
          <h3 className="font-medium text-[var(--google-text-primary)] mb-4" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
            Add Custom Nameserver Configuration
          </h3>
          <div className="space-y-4">
            <div>
              <label htmlFor="ns-config-name" className="block text-sm font-medium text-[var(--google-text-primary)] mb-2" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                Configuration Name
              </label>
              <input
                id="ns-config-name"
                type="text"
                value={newConfig.name}
                onChange={(e) => setNewConfig(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., My Custom DNS"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--google-blue)] focus:border-transparent"
                style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
              />
            </div>
            <div>
              {/* Labels a dynamic group of nameserver inputs, not one control. */}
              <span className="block text-sm font-medium text-[var(--google-text-primary)] mb-2" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                Nameservers
              </span>
              <div className="space-y-2" role="group" aria-label="Nameservers">
                {newConfig.servers.map((server, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      type="text"
                      value={server}
                      onChange={(e) => handleServerChange(index, e.target.value)}
                      placeholder={`ns${index + 1}.example.com`}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[var(--google-blue)] focus:border-transparent"
                      style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
                    />
                    {newConfig.servers.length > 1 && (
                      <button
                        onClick={() => handleRemoveServer(index)}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={handleAddServer}
                  className="flex items-center gap-2 text-[var(--google-blue)] hover:text-[var(--google-blue-dark)] transition-colors"
                  style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
                >
                  <Plus className="w-4 h-4" />
                  Add Another Nameserver
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveNew}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--google-blue)] text-white rounded-lg hover:bg-[var(--google-blue-dark)] transition-colors"
                style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
              >
                <Save className="w-4 h-4" />
                Save Configuration
              </button>
              <button
                onClick={() => {
                  setIsAddingNew(false);
                  setNewConfig({ name: '', servers: ['', ''], isDefault: false, isActive: true });
                }}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-[var(--google-text-secondary)] rounded-lg hover:bg-gray-50 transition-colors"
                style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Configuration List */}
      <div className="space-y-3">
        <h3 className="font-medium text-[var(--google-text-primary)] mb-3" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
          Available Configurations
        </h3>
        {configs.map((config) => (
          <div
            key={config.id}
            className={`p-4 rounded-lg border transition-colors ${config.isActive
              ? 'border-[var(--google-blue)] bg-[var(--google-blue-light)]'
              : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-medium text-[var(--google-text-primary)]" style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}>
                    {config.name}
                  </h4>
                  {config.isDefault && (
                    <span className="px-2 py-1 text-xs font-medium text-[var(--google-blue)] bg-[var(--google-blue-light)] rounded-full">
                      Default
                    </span>
                  )}
                  {config.isActive && (
                    <span className="px-2 py-1 text-xs font-medium text-white bg-green-500 rounded-full">
                      Active
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {config.servers.map((server, index) => (
                    <span
                      key={index}
                      className="px-2 py-1 text-sm bg-white border border-gray-200 rounded text-[var(--google-text-secondary)]"
                      style={{ fontFamily: 'Roboto, system-ui, sans-serif' }}
                    >
                      {server}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 ml-4">
                {!config.isActive && (
                  <button
                    onClick={() => handleSetActive(config.id)}
                    className="p-2 text-[var(--google-blue)] hover:bg-[var(--google-blue-light)] rounded-lg transition-colors"
                    title="Set as Active"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                )}
                {!config.isDefault && (
                  <button
                    onClick={() => handleDelete(config.id)}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    title="Delete Configuration"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Reset to Default */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <button
          onClick={handleResetToDefault}
          className="flex items-center gap-2 px-4 py-2 text-[var(--google-text-secondary)] hover:text-[var(--google-text-primary)] transition-colors"
          style={{ fontFamily: 'Google Sans, system-ui, sans-serif' }}
        >
          <RotateCcw className="w-4 h-4" />
          Reset to Default Nameservers
        </button>
      </div>
    </div>
  );
}
