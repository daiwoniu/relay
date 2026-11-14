import { z } from 'zod';

export const RELAY_PROTOCOL_VERSION = 35 as const;
export const RelayProtocolVersionSchema = z.literal(RELAY_PROTOCOL_VERSION);
