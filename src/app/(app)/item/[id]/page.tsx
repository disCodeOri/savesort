import { EditItemClient } from "@/components/edit-item-client";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EditItemClient id={id} />;
}
