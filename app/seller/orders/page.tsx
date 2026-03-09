import { connection } from "next/server";
import { Suspense } from "react";
import SellerOrdersClient from "./SellerOrdersClient";

export default async function Page() {
  await connection();

  return (
    <Suspense fallback={null}>
      <SellerOrdersClient />
    </Suspense>
  );
}
