import React, { useState, ChangeEvent, useEffect } from 'react';
import { Button, Input } from '@/components/ui';
import { VSCodeBadge } from '@vscode/webview-ui-toolkit/react';
import { vscode } from '@/utils/vscode'; // Assuming a utility for vscode API

interface ClarifaiSettingsProps {
  className?: string;
}

export const ClarifaiSettings: React.FC<ClarifaiSettingsProps> = ({
  className
}) => {
  const [pat, setPat] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.clarifai.com');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<boolean | null>(null); // State for save result

  useEffect(() => {
    // Request initial settings from extension
    vscode.postMessage({ type: 'getClarifaiSettings' });

    // Listen for settings from extension
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'clarifaiSettings') {
        setPat(message.pat || '');
        setBaseUrl(message.baseUrl || 'https://api.clarifai.com');
      } else if (message.type === 'clarifaiTestResult') {
        setIsTesting(false); // Stop testing animation
        setTestResult(message.success);
      } else if (message.type === 'clarifaiSettingsSaved') {
        setIsSaving(false); // Stop saving animation
        setSaveResult(message.success);
        if (!message.success) {
          console.error("Failed to save Clarifai settings:", message.error);
        }
      }
    };

    window.addEventListener('message', handler);

    return () => {
      window.removeEventListener('message', handler);
    };
  }, []);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    setSaveResult(null); // Clear save result on test
    vscode.postMessage({ type: 'testClarifaiConnection', pat, baseUrl });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveResult(null); // Clear previous save result
    setTestResult(null); // Clear test result on save
    vscode.postMessage({ type: 'saveClarifaiSettings', pat, baseUrl });
    // The saveResult message handler will set isSaving(false)
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="space-y-2">
        <label className="text-sm font-medium">PAT Token</label>
        <Input
          type="password"
          value={pat}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setPat(e.target.value)}
          placeholder="Enter your Clarifai PAT token"
        />
      </div>
      
      <div className="space-y-2">
        <label className="text-sm font-medium">API Base URL</label>
        <Input
          value={baseUrl}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setBaseUrl(e.target.value)}
          placeholder="https://api.clarifai.com"
        />
      </div>

      {testResult !== null && (
        <VSCodeBadge className={`mt-2 ${testResult ? 'bg-green-500' : 'bg-red-500'}`}>
          {testResult ? '✓ Connection successful' : '✗ Connection failed'}
        </VSCodeBadge>
      )}

      {saveResult !== null && (
        <VSCodeBadge className={`mt-2 ${saveResult ? 'bg-green-500' : 'bg-red-500'}`}>
          {saveResult ? '✓ Settings saved' : '✗ Failed to save settings'}
        </VSCodeBadge>
      )}

      <div className="flex space-x-2">
        <Button
          onClick={handleTestConnection}
          disabled={!pat || isTesting}
        >
          {isTesting ? 'Testing...' : 'Test Connection'}
        </Button>
        
        <Button
          onClick={handleSave}
          disabled={!pat || isSaving}
          variant="default"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
};