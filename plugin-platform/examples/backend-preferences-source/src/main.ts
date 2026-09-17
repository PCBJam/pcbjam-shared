pcbjam.handle("load", async () => {
  const response = await pcbjam.http.request("backend", {
    method: "GET",
    path: "/v1/preferences",
  });
  if (response.status !== 200) throw new Error("Could not load preferences");
  return response.body;
});
pcbjam.handle("save", async (input: unknown) => {
  if (
    !input ||
    typeof input !== "object" ||
    !("library" in input) ||
    typeof input.library !== "string" ||
    input.library.length > 100
  )
    throw new Error("Enter a library name, up to 100 characters");
  const response = await pcbjam.http.request("backend", {
    method: "POST",
    path: "/v1/preferences",
    json: { library: input.library },
  });
  if (response.status !== 200) throw new Error("Could not save preferences");
  return response.body;
});
