export function buildUploadEndpoint(apiDomain, key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${apiDomain}/upload/${encodedKey}`;
}

export async function uploadBuffer({
  apiDomain,
  token,
  key,
  contentType,
  body,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(buildUploadEndpoint(apiDomain, key), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
    },
    body,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${responseText}`);
  }

  return JSON.parse(responseText);
}
