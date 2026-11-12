import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { users } from "../../models/users.js";
import { isDuplicateEntry } from "../support/dbErrors.js";
import { hashPassword } from "./passwords.js";

function sorted(values) {
  return [...values].sort();
}

/** The raw user row for an email (the database collation makes the match case-insensitive). */
export async function findUserByEmail(email) {
  const [row] = await db.select().from(users).where(eq(users.email, email.trim())).limit(1);

  return row ?? null;
}

/**
 * The signed-in user as the rest of the app sees them: branch, role names and the flattened,
 * de-duplicated permission names. Null when the user is missing or inactive.
 */
export async function loadAuthUser(userId) {
  const user = await db.query.users.findFirst({
    where: { id: userId },
    with: {
      branch: true,
      userRoles: { with: { role: { with: { rolePermissions: { with: { permission: true } } } } } },
    },
  });

  if (!user || !user.isActive) {
    return null;
  }

  const roles = new Set();
  const permissions = new Set();

  for (const { role } of user.userRoles) {
    roles.add(role.name);

    for (const { permission } of role.rolePermissions) {
      permissions.add(permission.name);
    }
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    branchId: user.branchId,
    branchCode: user.branch?.code ?? null,
    branchName: user.branch?.name ?? null,
    roles: sorted(roles),
    permissions: sorted(permissions),
  };
}

/** Creates an active user with no roles and no branch. Returns null when the email is taken. */
export async function createUser({ name, email, password }) {
  const id = randomUUID();

  try {
    await db
      .insert(users)
      .values({ id, name, email: email.trim(), password: await hashPassword(password) });

    return { id };
  } catch (error) {
    if (isDuplicateEntry(error)) {
      return null;
    }

    throw error;
  }
}

export async function listUsers() {
  const rows = await db.query.users.findMany({
    with: { branch: true, userRoles: { with: { role: true } } },
    orderBy: { name: "asc" },
  });

  return rows.map((user) => {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      branchName: user.branch?.name ?? null,
      roles: sorted(
        user.userRoles.map(({ role }) => {
          return role.name;
        }),
      ),
      isActive: user.isActive,
    };
  });
}
