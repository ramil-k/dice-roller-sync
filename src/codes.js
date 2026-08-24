// Room-code generator: adjective-noun-NNN, unguessable enough to act as the
// room secret while staying easy to read out loud at the table.
import { randomInt } from 'node:crypto';

const ADJECTIVES = [
  'brave', 'calm', 'clever', 'crimson', 'dusty', 'eager', 'fierce', 'gentle',
  'gilded', 'grim', 'hazy', 'iron', 'jolly', 'lucky', 'misty', 'noble',
  'polar', 'quick', 'rusty', 'sable', 'silent', 'sly', 'stormy', 'swift',
  'thorny', 'umber', 'vivid', 'wild', 'witty', 'zesty',
];

const NOUNS = [
  'badger', 'basilisk', 'beacon', 'cauldron', 'comet', 'dagger', 'dragon',
  'falcon', 'gargoyle', 'goblet', 'griffin', 'hammer', 'hydra', 'kraken',
  'lantern', 'lynx', 'mammoth', 'otter', 'owlbear', 'phoenix', 'raven',
  'saddle', 'salamander', 'sphinx', 'tankard', 'tower', 'viper', 'wyvern',
];

export const newCode = () =>
  `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}-${randomInt(1000, 10000)}`;

// Codes travel in URLs and file paths - keep validation strict.
export const isValidCode = (code) =>
  typeof code === 'string' && /^[a-z]+-[a-z]+-\d{4}$/.test(code);
