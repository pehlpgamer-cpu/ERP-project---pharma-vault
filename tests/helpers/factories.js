import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { branches } from "../../app/models/branches.js";
import { permissions } from "../../app/models/permissions.js";
import { rolePermissions } from "../../app/models/role-permissions.js";
import { roles } from "../../app/models/roles.js";
import { userRoles } from "../../app/models/user-roles.js";
import { users } from "../../app/models/users.js";
import { hashPassword } from "../../app/services/auth/passwords.js";

let counter = 0;
const passwordHashes = new Map();

function nextNumber() {
  counter += 1;

  return counter;
}

// Hashing is the slow part of making a user; one hash per distinct plain password is enough.
async function hashOnce(password) {
  if (!passwordHashes.has(password)) {
    passwordHashes.set(password, await hashPassword(password));
  }

  return passwordHashes.get(password);
}

async function findOrCreatePermission(name) {
  const [existing] = await db.select().from(permissions).where(eq(permissions.name, name)).limit(1);

  if (existing) {
    return existing.id;
  }

  const id = randomUUID();
  await db.insert(permissions).values({ id, name });

  return id;
}

async function findOrCreateRole(name, permissionNames) {
  const [existing] = await db.select().from(roles).where(eq(roles.name, name)).limit(1);

  if (existing) {
    return existing.id;
  }

  const roleId = randomUUID();
  await db.insert(roles).values({ id: roleId, name });

  for (const permissionName of permissionNames) {
    await db
      .insert(rolePermissions)
      .values({ roleId, permissionId: await findOrCreatePermission(permissionName) });
  }

  return roleId;
}

export async function makeBranch({ code, name } = {}) {
  const number = nextNumber();
  const branchCode = code ?? `B${number}`;
  const branch = { id: randomUUID(), code: branchCode, name: name ?? `Branch ${branchCode}` };

  await db.insert(branches).values(branch);

  return branch;
}

/** Gives a user a role (created with exactly these permissions when it does not exist yet). */
export async function assignRole(userId, roleName, permissionNames = []) {
  const roleId = await findOrCreateRole(roleName, permissionNames);

  await db.insert(userRoles).values({ userId, roleId });
}

/**
 * Creates a user with one role holding exactly `permissions`. `password` is the plain value, also
 * returned so tests can sign in.
 */
export async function makeUser({
  branchId = null,
  permissions: permissionNames = [],
  roleName,
  email,
  password = "correct horse battery",
  name,
  isActive = true,
} = {}) {
  const number = nextNumber();
  const user = {
    id: randomUUID(),
    email: email ?? `user${number}@pharmavault.test`,
    name: name ?? `User ${number}`,
    branchId,
  };

  await db.insert(users).values({ ...user, password: await hashOnce(password), isActive });
  await assignRole(user.id, roleName ?? `role-${number}`, permissionNames);

  return { ...user, password };
}
