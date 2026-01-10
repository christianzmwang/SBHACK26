import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn({ user, account }) {
      // Upsert user in backend database when they sign in
      if (account?.provider === "google" && user.email) {
        try {
          const response = await fetch(`${BACKEND_URL}/api/users/upsert`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              googleId: account.providerAccountId,
              email: user.email,
              name: user.name,
              image: user.image,
            }),
          });

          if (!response.ok) {
            console.error("Failed to upsert user in database");
            // Still allow sign in even if backend call fails
          } else {
            const data = await response.json();
            // Store the database UUID in the user object for the JWT callback
            if (data.user?.id) {
              (user as any).dbId = data.user.id;
            }
          }
        } catch (error) {
          console.error("Error upserting user:", error);
          // Still allow sign in even if backend call fails
        }
      }
      return true;
    },
    async jwt({ token, user, account }) {
      // Persist the OAuth access_token and database user id
      if (account) {
        token.accessToken = account.access_token;
        token.googleId = account.providerAccountId;
      }
      if (user) {
        // Use the database UUID if available, otherwise we'll look it up
        token.dbId = (user as any).dbId;
      }
      
      // If we don't have a dbId yet but have a googleId, try to fetch it
      if (!token.dbId && token.googleId) {
        try {
          const response = await fetch(
            `${BACKEND_URL}/api/users/by-google-id/${token.googleId}`
          );
          if (response.ok) {
            const data = await response.json();
            token.dbId = data.user?.id;
          }
        } catch (error) {
          console.error("Error fetching user by google id:", error);
        }
      }
      
      return token;
    },
    async session({ session, token }) {
      // Add the database user id to the session
      if (token.dbId) {
        session.user.id = token.dbId as string;
      } else if (token.sub) {
        // Fallback to Google ID if dbId not available
        session.user.id = token.sub;
      }
      return session;
    },
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.AUTH_SECRET,
});
