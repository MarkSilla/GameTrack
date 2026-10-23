import { useState } from 'react';
import { Gamepad2 } from 'lucide-react';

type IconGame = { name: string; executable?: string; iconUrl?: string; iconDataUrl?: string };

function resolveIcon(game: IconGame) {
  const data = String(game.iconDataUrl || '').trim();
  if (/^data:image\//i.test(data)) return data;
  const url = String(game.iconUrl || '').trim();
  if (/^https:\/\//i.test(url)) return url;
  const value = `${game.name} ${game.executable || ''}`.toLowerCase();
  if (value.includes('valorant')) return 'https://cdn.simpleicons.org/valorant';
  if (value.includes('league of legends') || value.includes('leagueclient')) return 'https://cdn.simpleicons.org/leagueoflegends';
  if (value.includes('roblox')) return 'https://cdn.simpleicons.org/roblox';
  if (value.includes('minecraft')) return 'https://cdn.simpleicons.org/minecraft';
  if (value.includes('steam')) return 'https://cdn.simpleicons.org/steam';
  return '';
}

export default function GameIcon({ game, size = 24, className = '' }: { game: IconGame; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = resolveIcon(game);
  if (!src || failed) return <Gamepad2 size={size} className={className} />;
  return <img src={src} alt="" className={className} onError={() => setFailed(true)} style={{ width: size, height: size, objectFit: 'contain', display: 'block', flex: '0 0 auto' }} />;
}
