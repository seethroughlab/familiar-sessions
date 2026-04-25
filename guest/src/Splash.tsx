import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio } from 'lucide-react';

export function Splash() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length >= 8) navigate(`/listen/${trimmed}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-900 to-black flex items-center justify-center p-4">
      <div className="bg-zinc-800/50 rounded-xl border border-zinc-700 p-8 max-w-md w-full">
        <div className="text-center mb-8">
          <Radio className="w-16 h-16 mx-auto mb-4 text-green-500" />
          <h1 className="text-2xl font-bold text-white">Familiar Sessions</h1>
          <p className="text-zinc-400 mt-2">
            Enter a session code to listen along with a friend.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Session code"
            className="w-full px-4 py-3 bg-zinc-700 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-green-500 text-center text-2xl tracking-widest font-mono uppercase"
            autoFocus
          />
          <button
            type="submit"
            disabled={code.trim().length < 8}
            className="w-full px-4 py-3 bg-green-600 hover:bg-green-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg font-medium transition-colors"
          >
            Continue
          </button>
        </form>

        <p className="text-xs text-zinc-500 text-center mt-8">
          Familiar Sessions is the public rendezvous service for{' '}
          <a href="https://familiar.app" className="underline hover:text-zinc-300">
            Familiar
          </a>
          .
        </p>
      </div>
    </div>
  );
}
