using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedMarkdown.Migrations
{
    /// <inheritdoc />
    public partial class AddDeletedDocuments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DeletedDocuments",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", nullable: false),
                    ReadId = table.Column<string>(type: "TEXT", nullable: true),
                    DeletedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeletedDocuments", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DeletedDocuments_ReadId",
                table: "DeletedDocuments",
                column: "ReadId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DeletedDocuments");
        }
    }
}
