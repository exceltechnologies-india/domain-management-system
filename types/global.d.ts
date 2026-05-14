// CSS module and side-effect import declarations for TypeScript 6+
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}
