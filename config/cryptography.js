// Argon2 options. Environment values are strings, so every option is coerced to a number.
export const argon2Config = {
  type: Number(process.env.ARGON2_TYPE ?? 2), // 2 = argon2id
  memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 19456),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
  hashLength: Number(process.env.ARGON2_HASH_LENGTH ?? 32),
  parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
};
