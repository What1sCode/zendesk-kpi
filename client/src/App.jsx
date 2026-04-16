import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import AgentProductivity from './components/AgentProductivity';
import AuthPage from './components/AuthPage';

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [activeTab, setActiveTab] = useState('efficiency');

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setUser(data || null);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <AuthPage onAuth={setUser} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-800">Zendesk KPI Dashboard</h1>
          <p className="text-sm text-gray-500">Time in Status &amp; Flapping Metrics</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user.name || user.email}</span>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Sign out
          </button>
        </div>
      </header>
      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200 px-6">
        <nav className="flex gap-6">
          {[
            { id: 'efficiency', label: 'Efficiency' },
            { id: 'productivity', label: 'Agent Productivity' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === 'efficiency' && <Dashboard />}
        {activeTab === 'productivity' && <AgentProductivity />}
      </main>
    </div>
  );
}
