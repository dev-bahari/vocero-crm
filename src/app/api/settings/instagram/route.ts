import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  getInstagramCredentialsByOrg,
  saveInstagramCredentials,
  tokenLast4,
} from "@/server/instagram/credentials";
import {
  channelDisabledResponse,
  isChannelEnabled,
} from "@/server/channels/enabled";

export const dynamic = "force-dynamic";

/** 014 — Estado de la conexión de Instagram (el token nunca sale entero). */
export const GET = withAuth(async (session) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  const creds = await getInstagramCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      source: creds.source,
      igUserId: creds.igUserId,
      accountRef: creds.accountRef,
      username: creds.username,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
    },
  });
});

const putSchema = z.object({
  source: z.enum(["zernio", "meta"]),
  igUserId: z.string().trim().min(1),
  accountRef: z.string().trim().min(1).nullish(),
  username: z.string().trim().nullish(),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().min(1).nullish(),
});

/**
 * Guarda la conexión validando ANTES contra la plataforma, igual que el
 * wizard de WhatsApp: un token que no sirve no llega a la base.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!isChannelEnabled("instagram")) return channelDisabledResponse();
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  if (data.source === "zernio" && !data.accountRef) {
    return apiError(
      422,
      "invalid_body",
      "En modo Zernio hace falta el accountId de la cuenta conectada"
    );
  }

  const check = await verify(data);
  if (!check.ok) {
    return apiError(check.status, check.code, check.message);
  }

  await saveInstagramCredentials({
    organizationId: session.organizationId,
    source: data.source,
    igUserId: data.igUserId,
    accountRef: data.accountRef ?? null,
    username: check.username ?? data.username ?? null,
    token: data.token,
    webhookSecret: data.webhookSecret ?? null,
  });

  return Response.json({ ok: true, username: check.username ?? null });
});

type Check =
  | { ok: true; username: string | null }
  | { ok: false; status: number; code: string; message: string };

async function verify(data: z.infer<typeof putSchema>): Promise<Check> {
  // Meta expone DOS ids del mismo perfil en /me:
  //   - `id` = Instagram-Scoped ID (el que devuelve /me?fields=id, ej. 28978671838402975)
  //   - `user_id` = App-Scoped ID (el que aparece en `entry.id` de los webhooks, ej. 17841477965412210)
  // La ingesta busca las credenciales por el ID del webhook, así que validamos
  // contra `user_id` para que ambas puntas hablen del mismo número.
  const url =
    data.source === "meta"
      ? `${process.env.IG_GRAPH_BASE_URL ?? "https://graph.instagram.com"}/${
          process.env.META_GRAPH_API_VERSION ?? "v25.0"
        }/me?fields=user_id,username`
      : `${process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1"}/inbox/conversations?limit=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
  } catch {
    return {
      ok: false,
      status: 503,
      code: "platform_unavailable",
      message: "No se pudo contactar la plataforma; intenta de nuevo",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: 422,
      code: "invalid_token",
      message:
        data.source === "meta"
          ? "El token de Instagram no es válido o no tiene permiso de mensajes"
          : "La API key de Zernio no es válida",
    };
  }

  if (data.source === "meta") {
    const json = (await res.json().catch(() => null)) as {
      user_id?: string;
      username?: string;
    } | null;
    if (json?.user_id && json.user_id !== data.igUserId) {
      return {
        ok: false,
        status: 422,
        code: "id_mismatch",
        message: `El IG_ID del token es ${json.user_id}, no ${data.igUserId}`,
      };
    }
    return { ok: true, username: json?.username ?? null };
  }

  return { ok: true, username: null };
}
